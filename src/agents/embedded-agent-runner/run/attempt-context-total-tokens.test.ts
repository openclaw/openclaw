import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCreatedSessionGoal } from "../../../config/sessions/goals-transitions.js";
import {
  loadSessionEntry,
  replaceSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import {
  resolveFreshSessionTotalTokens,
  SESSION_TOTAL_TOKENS_VERSION,
  type InternalSessionEntry,
} from "../../../config/sessions/types.js";
import { PROGRESS_CARD_REFRESH_SOURCE_TOOL } from "../../../sessions/input-provenance.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import type { NormalizedUsage } from "../../usage.js";
import { createContextTotalTokensWriter } from "./attempt-context-total-tokens.js";

type Attempt = Parameters<typeof createContextTotalTokensWriter>[0];

async function withSession(
  body: (fixture: {
    attempt: (overrides?: Partial<Attempt>) => Attempt;
    replace: (patch: Partial<InternalSessionEntry>) => Promise<unknown>;
    read: () => InternalSessionEntry | undefined;
  }) => Promise<void>,
) {
  await withOpenClawTestState(
    { label: "attempt-context-total-tokens", scenario: "minimal" },
    async (state) => {
      const scope = {
        agentId: "main",
        storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
        sessionKey: "agent:main:attempt-context-total-tokens",
      };
      // Bootstrap stamps a known zero; status readers see it for the whole turn without this writer.
      const entry: InternalSessionEntry = {
        sessionId: randomUUID(),
        lifecycleRevision: randomUUID(),
        activeWriterRunId: "run-1",
        updatedAt: 1,
        totalTokens: 0,
        totalTokensFresh: true,
        totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
      };
      await replaceSessionEntry(scope, entry);
      await body({
        attempt: (overrides) => ({
          runId: "run-1",
          sessionId: entry.sessionId,
          sessionPersistence: "durable",
          sessionTarget: {
            ...scope,
            sessionId: entry.sessionId,
            expectedLifecycleRevision: entry.lifecycleRevision,
            expectedWriterRunId: "run-1",
          },
          ...overrides,
        }),
        replace: (patch) => replaceSessionEntry(scope, { ...entry, ...patch }),
        read: () => loadSessionEntry({ ...scope, readConsistency: "latest" }),
      });
    },
  );
}

const usage = (partial: Partial<NormalizedUsage>): NormalizedUsage => ({
  input: 0,
  output: 0,
  ...partial,
});

describe("createContextTotalTokensWriter", () => {
  it("writes a settled call as it is offered and drops only the pending one on abandon", async () => {
    await withSession(async (fixture) => {
      const writer = createContextTotalTokensWriter(fixture.attempt());
      writer.offer(usage({ input: 20_000, cacheRead: 15_000, output: 700 }));
      writer.offer(usage({ input: 60_000, output: 100 }));
      await writer.abandon();
      expect(resolveFreshSessionTotalTokens(fixture.read())).toBe(35_000);
    });
  });

  it("lands the latest offer on close, including a smaller one after compaction", async () => {
    await withSession(async (fixture) => {
      const writer = createContextTotalTokensWriter(fixture.attempt());
      writer.offer(usage({ input: 180_000, output: 100 }));
      // The attempt compacted; the next call's context is much smaller.
      writer.offer(usage({ input: 50_000, output: 100 }));
      await writer.close();
      expect(resolveFreshSessionTotalTokens(fixture.read())).toBe(50_000);

      // A retry after truncating tool results is another attempt of the same run.
      const retry = createContextTotalTokensWriter(fixture.attempt());
      retry.offer(usage({ input: 30_000, output: 100 }));
      await retry.close();
      expect(resolveFreshSessionTotalTokens(fixture.read())).toBe(30_000);
    });
  });

  it.each([
    { name: "a fresh", totalTokensFresh: true },
    { name: "an unknown", totalTokensFresh: false },
  ])("replaces $name pre-run value with the first settled call", async ({ totalTokensFresh }) => {
    await withSession(async (fixture) => {
      // The previous turn ended larger than this run's first call, e.g. before a model switch.
      await fixture.replace({ totalTokens: 200_000, totalTokensFresh });
      const writer = createContextTotalTokensWriter(fixture.attempt());
      writer.offer(usage({ input: 150_000, output: 100 }));
      await writer.close();
      expect(resolveFreshSessionTotalTokens(fixture.read())).toBe(150_000);
    });
  });

  it("runs goal accounting with each published total and limits the goal at its budget", async () => {
    await withSession(async (fixture) => {
      const row = fixture.read();
      if (!row) {
        throw new Error("expected the seeded session row");
      }
      await fixture.replace({
        goal: buildCreatedSessionGoal(row, { objective: "ship", tokenBudget: 50_000 }, 1),
      });

      const below = createContextTotalTokensWriter(fixture.attempt());
      below.offer(usage({ input: 40_000, output: 100 }));
      await below.close();
      expect(fixture.read()?.goal).toMatchObject({ status: "active", tokensUsed: 40_000 });

      const crossing = createContextTotalTokensWriter(fixture.attempt());
      crossing.offer(usage({ input: 60_000, output: 100 }));
      await crossing.close();
      expect(fixture.read()?.goal).toMatchObject({
        status: "budget_limited",
        tokensUsed: 60_000,
        budgetLimitedAt: expect.any(Number),
      });
    });
  });

  it("does not stamp a session that lost the attempt's admission or rotated", async () => {
    await withSession(async (fixture) => {
      const target = fixture.attempt().sessionTarget;
      for (const attempt of [
        fixture.attempt({ sessionTarget: { ...target, expectedLifecycleRevision: randomUUID() } }),
        fixture.attempt({ sessionTarget: { ...target, expectedWriterRunId: "run-0" } }),
      ]) {
        const writer = createContextTotalTokensWriter(attempt);
        writer.offer(usage({ input: 80_000, output: 500 }));
        await writer.close();
      }
      expect(fixture.read()?.totalTokens).toBe(0);

      const writer = createContextTotalTokensWriter(fixture.attempt());
      // /new replaces the row with a fresh session mid-run.
      const rotatedSessionId = randomUUID();
      await fixture.replace({
        sessionId: rotatedSessionId,
        lifecycleRevision: randomUUID(),
        totalTokens: undefined,
        totalTokensFresh: undefined,
        totalTokensVersion: undefined,
      });
      writer.offer(usage({ input: 80_000, output: 500 }));
      await writer.close();
      const row = fixture.read();
      expect(row?.sessionId).toBe(rotatedSessionId);
      expect(resolveFreshSessionTotalTokens(row)).toBeUndefined();
    });
  });

  it("fences a run admitted before its row existed on the writer it created", async () => {
    await withSession(async (fixture) => {
      const target = fixture.attempt().sessionTarget;
      const unclaimed = fixture.attempt({
        sessionTarget: {
          ...target,
          expectedLifecycleRevision: undefined,
          expectedWriterRunId: undefined,
        },
      });
      const first = createContextTotalTokensWriter(unclaimed);
      first.offer(usage({ input: 50_000, output: 100 }));
      await first.close();
      expect(fixture.read()?.totalTokens).toBe(50_000);

      // A reset keeps the session id, mints a new lifecycle and drops the writer claim.
      await fixture.replace({
        lifecycleRevision: randomUUID(),
        activeWriterRunId: undefined,
        totalTokens: 0,
      });
      const afterReset = createContextTotalTokensWriter(unclaimed);
      afterReset.offer(usage({ input: 80_000, output: 100 }));
      await afterReset.close();
      expect(fixture.read()?.totalTokens).toBe(0);
    });
  });

  it("stores prompt tokens only and leaves an unavailable snapshot unknown", async () => {
    await withSession(async (fixture) => {
      const unknown = createContextTotalTokensWriter(fixture.attempt());
      unknown.offer(usage({ input: 9_000, output: 100, contextUsage: { state: "unavailable" } }));
      await unknown.close();
      expect(fixture.read()?.totalTokens).toBe(0);

      const known = createContextTotalTokensWriter(fixture.attempt());
      known.offer(usage({ input: 10_000, cacheRead: 30_000, cacheWrite: 500, output: 800 }));
      await known.close();
      expect(fixture.read()?.totalTokens).toBe(40_500);
    });
  });

  it("writes nothing after close, for detached runs, or for runs that preserve session state", async () => {
    await withSession(async (fixture) => {
      const closed = createContextTotalTokensWriter(fixture.attempt());
      await closed.close();
      closed.offer(usage({ input: 10_000, output: 20 }));
      // A second drain would wait out any write the late offer started.
      await closed.close();
      const disabled: Partial<Attempt>[] = [
        { sessionPersistence: "detached" },
        {
          inputProvenance: {
            kind: "internal_system",
            sourceTool: PROGRESS_CARD_REFRESH_SOURCE_TOOL,
          },
        },
      ];
      for (const overrides of disabled) {
        const writer = createContextTotalTokensWriter(fixture.attempt(overrides));
        writer.offer(usage({ input: 10_000, output: 20 }));
        await writer.close();
      }
      expect(fixture.read()?.totalTokens).toBe(0);
    });
  });
});

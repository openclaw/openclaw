import { expect, it } from "vitest";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import type { SessionCompactionSourceConsumer } from "../../config/sessions/session-compaction-source.types.js";
import { withSessionTranscriptReadSource } from "../../config/sessions/session-transcript-read-source.js";
import { compactionLane } from "../../config/sessions/session-transcript-worker-resources.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { registerAgentSessionLoopTestLifecycle } from "./agent-session-loop-correctness.test-support.js";
import {
  assistantText,
  sessionScope,
  withTranscriptState,
} from "./session-manager-fixtures.test-support.js";
import { SessionManager } from "./session-manager.js";

registerAgentSessionLoopTestLifecycle();

async function seedArchive(scope: Parameters<typeof SessionManager.openAsync>[0], label: string) {
  const manager = await SessionManager.openAsync(scope);
  await manager.appendMessageAsync(makeUserMessage(`Summarize the ${label} archive`, 1));
  for (let index = 0; index < 24; index++) {
    await manager.appendMessageAsync(
      assistantText(`${label} item ${index}: ${"payload ".repeat(1024)}`),
    );
  }
  await manager.appendMessageAsync(makeUserMessage(`Keep the ${label} request`, 100));
  return manager;
}

function compactInLane(
  scope: Parameters<typeof SessionManager.openAsync>[0] & { sessionId: string },
  consume: SessionCompactionSourceConsumer,
  signal?: AbortSignal,
) {
  return withSessionTranscriptReadSource(
    scope,
    (read) =>
      read.owner.withCompactionSource(
        {
          target: scope,
          resolvedScope: read.resolved,
          expectedIdentity: read.expectedIdentity,
          settings: { enabled: true, reserveTokens: 1000, keepRecentTokens: 1 },
          manual: true,
          safeguard: { recentTurnsPreserve: 3, qualityGuardEnabled: true },
        },
        consume,
        signal,
      ),
    signal,
    compactionLane,
  );
}

it("lets another session summarize while one summary request is pending", () =>
  withTranscriptState("concurrent-compaction-a", async ({ scope }) => {
    const other = sessionScope(scope.storePath, "concurrent-compaction-b");
    await upsertSessionEntryCore(other, { sessionId: other.sessionId, updatedAt: 1 });
    const archive = await seedArchive(scope, "alpha");
    await seedArchive(other, "beta");
    const aAtModel = createDeferredCore();
    const aModel = createDeferredCore();
    const a = compactInLane(scope, async (_plan, source) => {
      const first = await source.history.serialize(8_000);
      aAtModel.resolve();
      // A's summary request is in flight; the provider has not answered.
      await aModel.promise;
      // A retry rereads the captured selection; history appended meanwhile stays out.
      expect(await source.history.serialize(8_000)).toEqual(first);
    });
    try {
      await aAtModel.promise;
      expect(compactionLane.pool.getSnapshot().activeTasks).toBe(0);
      await archive.appendMessageAsync(makeUserMessage("appended while summarizing", 200));
      let summarized = "";
      await compactInLane(other, async (_plan, source) => {
        summarized = (await source.history.serialize(8_000)).text;
      });
      expect(summarized).toContain("Summarize the beta archive");
    } finally {
      aModel.resolve();
      await a;
    }
  }));

it("bounds payloads and rejects rewrites between short reads", () =>
  withTranscriptState("bounded-compaction-source", async ({ scope }) => {
    const manager = await seedArchive(scope, "bounded");
    await compactInLane(scope, async (plan, source) => {
      expect(JSON.stringify(plan).length).toBeLessThan(30_000);
      expect(plan.retained).toHaveLength(1);
      const rendered = await source.history.serialize(8_000);
      expect(rendered.text.length).toBeLessThanOrEqual(8_000);
      expect(rendered.text).toContain("Summarize the bounded archive");
      expect(compactionLane.pool.getSnapshot().activeTasks).toBe(0);
      await manager.removeTrailingEntriesAsync((entry) => entry.type === "message");
      await expect(source.history.serialize(8_000)).rejects.toThrow(
        "Session transcript changed during context read",
      );
    });
    expect(compactionLane.pool.getSnapshot().activeTasks).toBe(0);
  }));

it("rejects cancellation without starting another read", () =>
  withTranscriptState("cancelled-compaction-source", async ({ scope }) => {
    await seedArchive(scope, "cancelled");
    const controller = new AbortController();
    await expect(
      compactInLane(
        scope,
        async (_plan, source) => {
          await source.history.serialize(8_000);
          controller.abort(new Error("cancel prepared compaction"));
          await source.history.serialize(8_000);
        },
        controller.signal,
      ),
    ).rejects.toThrow("cancel prepared compaction");
    expect(compactionLane.pool.getSnapshot().activeTasks).toBe(0);
  }));

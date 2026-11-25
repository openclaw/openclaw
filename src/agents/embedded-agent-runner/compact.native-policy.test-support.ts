import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createAssistant,
  createAssistantResultStream,
  testModel,
} from "../sessions/agent-session-loop-correctness.test-support.js";
import type { createDelegateCompactionFixture } from "./compact.delegate.test-support.js";
import { hookRunner } from "./compact.hooks.harness.js";

/** Real native delegate regressions reuse the durable suite's external provider fixture. */
export function registerNativeCompactionPolicyTests(params: {
  createFixture: () => ReturnType<typeof createDelegateCompactionFixture>;
  runtime: () => {
    sessions: typeof import("../sessions/index.js");
    accessor: typeof import("../../config/sessions/session-accessor.js");
    workspaceDir: string;
    accounting: typeof import("./run/compaction-accounting-bridge.js");
    delegate: typeof import("../../context-engine/delegate.js").delegateCompactionToRuntime;
    requestBudgets: typeof import("../sessions/compaction/request-budget.js");
  };
}) {
  it.each(["summary", "floor", "timeout", "timeout-cancel"] as const)(
    "uses the execution policy for native budgeted preparation without pending input (%s)",
    async (route) => {
      const { sessions, accessor, workspaceDir, accounting, delegate } = params.runtime();
      const fixture = await params.createFixture();
      const target = {
        ...fixture.target,
        sessionId: "native-policy",
        sessionKey: "agent:main:native-policy",
      };
      await accessor.upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      const manager = await sessions.SessionManager.openAsync(target, workspaceDir);
      const ids: string[] = [];
      for (let index = 0; index < 8; index++) {
        const id = await manager.appendMessageAsync({
          role: "user",
          content: "x".repeat(800),
          timestamp: index,
        });
        if (!id) {
          throw new Error("Expected the persisted native compaction fixture message");
        }
        ids.push(id);
      }
      const config: OpenClawConfig = {
        ...fixture.runtimeContext.config,
        agents: {
          ...fixture.runtimeContext.config.agents,
          defaults: {
            compaction: {
              mode: "default",
              keepRecentTokens: 1_000,
              maxSummaryChars: 1_000,
              postIndexSync: "off",
            },
          },
        },
      };
      const runtimeContext = {
        ...fixture.runtimeContext,
        trigger: "budget" as const,
        config,
        summaryRefusal: route === "floor" ? "floor" : undefined,
      };
      if (route.startsWith("timeout")) {
        fixture.stream.mockImplementationOnce((activeModel) =>
          createAssistantResultStream({
            ...createAssistant(activeModel, [], "error"),
            errorMessage: "408 upstream request timed out",
          }),
        );
      }
      accounting.attachCompactionAccountingRecorder(runtimeContext, {
        requestBudget: {
          contextWindow: 1_500,
          reserveTokens: 100,
          fixedTokens: 100,
          pendingTokens: 0,
        },
        recordCompaction: fixture.recordCompaction,
      });
      const native = await import("../../config/sessions/session-compaction-prepared.js");
      const nativeRead = native.readPreparedSessionCompactionInWorker;
      const read = vi.spyOn(native, "readPreparedSessionCompactionInWorker");
      const safety = await import("./compaction-safety-timeout.js");
      const withTimeout = safety.compactWithSafetyTimeout;
      const attempt = new AbortController();
      let attemptSignal: AbortSignal | undefined;
      const timeout = vi.spyOn(safety, "compactWithSafetyTimeout");
      if (route === "timeout-cancel") {
        timeout.mockImplementation((compact, ms, options) =>
          withTimeout(
            (signal, reset) => {
              attemptSignal = signal ? AbortSignal.any([signal, attempt.signal]) : attempt.signal;
              return compact(attemptSignal, reset);
            },
            ms,
            options,
          ),
        );
        read.mockImplementation(async (readTarget, operation, signal) => {
          if (
            operation.kind === "plan" &&
            operation.options.work.summaryOutputPolicy === "deterministic"
          ) {
            attempt.abort(new Error("cancel fallback planning"));
            expect.soft(signal).toBe(attemptSignal);
            expect.soft(signal?.aborted).toBe(true);
            throw new Error("cancel fallback planning");
          }
          return nativeRead(readTarget, operation, signal);
        });
      }
      try {
        const result = await delegate({
          sessionId: target.sessionId,
          sessionKey: target.sessionKey,
          sessionTarget: target,
          runtimeContext,
        });
        if (route === "timeout-cancel") {
          expect(result).toMatchObject({ ok: false, compacted: false });
          expect(fixture.recordCompaction).not.toHaveBeenCalled();
          expect(read.mock.calls.filter(([, request]) => request.kind === "plan")).toHaveLength(2);
          return;
        }
        const planCall = read.mock.calls.findIndex(([, operation]) => operation.kind === "plan");
        const operation = read.mock.calls[planCall]?.[1];
        const plan = await read.mock.results[planCall]?.value;
        expect.soft(operation).toMatchObject({
          options: {
            work: {
              mode: "manual",
              summaryOutputPolicy: route === "floor" ? "deterministic" : "retry-invalid-once",
            },
          },
        });
        expect.soft(plan).toMatchObject({
          status: "prepared",
          plan: { preparation: { firstKeptEntryId: ids[6], summaryTokenBudget: 618 } },
        });
        expect(result, JSON.stringify(result)).toMatchObject({
          ok: true,
          compacted: true,
          result: { firstKeptEntryId: ids[6] },
        });
        expect(fixture.stream).toHaveBeenCalledTimes(route === "floor" ? 0 : 1);
        expect(fixture.recordCompaction).toHaveBeenCalledOnce();
        if (route === "timeout") {
          expect(read.mock.calls.filter(([, request]) => request.kind === "plan")).toHaveLength(2);
        }
      } finally {
        read.mockRestore();
        timeout.mockRestore();
      }
    },
  );

  it("reports retained content estimates without substituting assistant usage accounting", async () => {
    const { sessions, workspaceDir, delegate } = params.runtime();
    const fixture = await params.createFixture();
    const manager = await sessions.SessionManager.openAsync(fixture.target, workspaceDir);
    await manager.appendResetBoundaryAsync("new");
    await manager.appendMessageAsync({ role: "user", content: "Earlier task", timestamp: 1 });
    await manager.appendMessageAsync({ role: "user", content: "Continue", timestamp: 2 });
    await manager.appendMessageAsync({
      ...createAssistant(testModel, "Ready.", "stop", 4000),
      timestamp: Date.now() + 60_000,
    });
    const result = await delegate({ ...fixture.delegateParams, currentTokenCount: 10_000 });
    expect(result).toMatchObject({ ok: true, compacted: true });
    const restored = await sessions.SessionManager.openAsync(fixture.target, workspaceDir);
    const committed = restored.getBranch().findLast((entry) => entry.type === "compaction");
    const { estimateTokens } =
      await import("../../../packages/agent-core/src/harness/compaction/compaction.js");
    const { sanitizeCompactionReplayMessages } = await import("../compaction-replay.js");
    const expected = sanitizeCompactionReplayMessages(
      restored.buildSessionContext().messages,
    ).reduce((sum, message) => sum + estimateTokens(message), 0);
    expect(committed?.tokensAfter).toBe(4001);
    expect(expected).toBeLessThan(500);
    expect(result.result?.tokensAfter).toBe(expected);
    expect(fixture.recordCompaction).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ tokensAfter: 4001 }),
    );
  });

  it.each([
    { budgeted: false, observed: 100, standalone: false },
    { budgeted: false, observed: undefined, standalone: false },
    { budgeted: true, observed: 100, standalone: false },
    { budgeted: false, observed: 100_000, standalone: true },
  ])(
    "keeps native reporting separate from committed accounting (budgeted=$budgeted, observed=$observed)",
    async ({ budgeted, observed, standalone }) => {
      const { sessions, workspaceDir, accounting, delegate, requestBudgets } = params.runtime();
      const fixture = await params.createFixture();
      const manager = await sessions.SessionManager.openAsync(fixture.target, workspaceDir);
      await manager.appendResetBoundaryAsync("new");
      await manager.appendMessageAsync({
        role: "user",
        content: "Review the earlier task.",
        timestamp: 1,
      });
      await manager.appendMessageAsync({ role: "user", content: "Continue", timestamp: 2 });
      fixture.stream.mockImplementation((activeModel) =>
        createAssistantResultStream(
          createAssistant(activeModel, [{ type: "text", text: "s".repeat(4_000) }]),
        ),
      );
      const requestBudget = {
        contextWindow: 20_000,
        reserveTokens: 100,
        fixedTokens: 100,
        pendingTokens: 37,
      };
      const config: OpenClawConfig = fixture.runtimeContext.config;
      const runtimeContext = {
        ...fixture.runtimeContext,
        config,
        trigger: budgeted ? ("budget" as const) : ("manual" as const),
      };
      if (standalone) {
        runtimeContext.config.agents!.defaults!.compaction!.maxSummaryChars = 20_000;
        await manager.appendCustomEntryAsync("openclaw.system-prompt", {
          tools: [
            {
              name: "prior_tool",
              description: "retained tool wording ".repeat(1200),
              parameters: { type: "object", properties: {} },
            },
          ],
        });
      }
      accounting.attachCompactionAccountingRecorder(runtimeContext, {
        ...(budgeted ? { requestBudget } : {}),
        recordCompaction: fixture.recordCompaction,
      });
      const result = await delegate({
        ...fixture.delegateParams,
        runtimeContext,
        currentTokenCount: observed,
      });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, compacted: true });
      const restored = await sessions.SessionManager.openAsync(fixture.target, workspaceDir);
      const committed = restored.getBranch().findLast((entry) => entry.type === "compaction");
      expect(committed?.tokensAfter).toBeGreaterThan(100);
      expect(fixture.recordCompaction).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ tokensAfter: committed?.tokensAfter }),
      );
      const { estimateTokens } =
        await import("../../../packages/agent-core/src/harness/compaction/compaction.js");
      const { sanitizeCompactionReplayMessages } = await import("../compaction-replay.js");
      const expected = standalone
        ? sanitizeCompactionReplayMessages(restored.buildSessionContext().messages).reduce(
            (sum, message) => sum + estimateTokens(message),
            0,
          )
        : budgeted
          ? requestBudgets.estimateCompactedRequestTokens(restored.buildSessionContext().messages, {
              ...requestBudget,
              pendingTokens: 0,
            })
          : undefined;
      expect(result.result?.tokensAfter).toBe(expected);
      expect(hookRunner.runAfterCompaction).toHaveBeenCalledWith(
        expect.objectContaining({ tokenCount: expected }),
        expect.anything(),
      );
    },
  );
}

import { describe, expect, it, vi } from "vitest";
import { commitCompactionSummary } from "../../../packages/agent-core/src/harness/compaction/compaction-floor.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import { setCompactionSafeguardCancellation } from "../agent-hooks/compaction-safeguard-runtime.js";
import {
  agentSessionAutomaticCompaction,
  agentSessionSetContextReplacementHook,
} from "./agent-session-compaction.js";
import {
  createAssistant,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { prepareAgentCompactionWork } from "./compaction/preparation.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

registerAgentSessionLoopTestLifecycle();

async function fixture() {
  const original = SessionManager.inMemory();
  await original.appendMessageAsync(
    makeUserMessage("Original removed ask #12345, preserve this exact identifier.", 1),
  );
  await original.appendMessageAsync({
    ...createAssistant(testModel, "Earlier answer."),
    timestamp: 2,
  });
  await original.appendMessageAsync(makeUserMessage("Recent request", 3));
  await original.appendMessageAsync({
    ...createAssistant(testModel, "Retained answer."),
    timestamp: 4,
  });
  const branch = original.getBranch();
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1 },
    retry: { enabled: false },
  });
  const full = prepareAgentCompactionWork(branch, {
    itemId: "fixture-plan",
    settings: settings.getCompactionSettings(),
    mode: "manual",
    summaryOutputPolicy: "none",
  });
  if (full.status !== "prepared") {
    throw new Error("Expected fixture preparation");
  }
  const manager = original;
  const result = {
    summary: "Prepared summary.",
    firstKeptEntryId: full.preparation.firstKeptEntryId,
    tokensBefore: full.preparation.tokensBefore,
  };
  const execute = vi.fn(
    async (_event: unknown, _ctx: { sessionManager: object }) =>
      ({ compaction: result }) as { compaction?: typeof result; cancel?: true },
  );
  const publicBefore = vi.fn(execute);
  const publicAfter = vi.fn();
  const { session } = await createTestSession({
    sessionManager: manager,
    settingsManager: settings,
    extension(api) {
      api.on("session_before_compact", publicBefore);
      api.on("session_compact", publicAfter);
    },
  });
  return {
    session,
    manager,
    full,
    result,
    execute,
    publicBefore,
    publicAfter,
  };
}

describe("public SDK compaction adapter", () => {
  it.each(["summary", "deterministic", "required-cancellation"] as const)(
    "settles %s with complete public preparation and existing durable executor",
    async (mode) => {
      const f = await fixture();
      if (mode === "required-cancellation") {
        f.execute.mockImplementation(async (_event, ctx) => {
          setCompactionSafeguardCancellation(
            ctx.sessionManager,
            "synthetic summary failure",
            new Error("synthetic"),
          );
          return { cancel: true };
        });
      }
      const outcome = await f.session[agentSessionAutomaticCompaction](
        undefined,
        undefined,
        mode === "deterministic" ? "deterministic" : "none",
        mode === "required-cancellation" ? { requestRequiresCompaction: true } : {},
      );
      expect(outcome.status).toBe("completed");
      if (outcome.status !== "completed") {
        throw new Error("Expected compaction receipt");
      }
      expect(f.publicBefore).toHaveBeenCalledTimes(mode === "deterministic" ? 0 : 1);
      expect(f.publicAfter).toHaveBeenCalledOnce();
      expect(f.manager.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
      expect(
        f.session.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.content.some(
              (block) => block.type === "text" && block.text === "Retained answer.",
            ),
        ),
      ).toBe(true);
      expect(outcome.result.summary).toContain("#12345");
      if (mode === "summary") {
        expect(outcome.result.summary).toBe(
          commitCompactionSummary(f.result, f.full.preparation, false),
        );
        expect(f.execute).toHaveBeenCalledOnce();
      } else {
        expect(outcome.result.summary).toContain("removed without a summary");
        expect(f.execute).toHaveBeenCalledTimes(mode === "deterministic" ? 0 : 1);
      }
    },
  );

  it.each(["abort", "retire"] as const)(
    "does not publish after %s while the prepared summary awaits",
    async (mode) => {
      const f = await fixture();
      const entered = createDeferred();
      const released = createDeferred();
      let active = true;
      f.session[agentSessionSetContextReplacementHook](undefined, () => {
        if (!active) {
          throw new Error("retired fixture owner");
        }
      });
      f.execute.mockImplementation(async () => {
        entered.resolve();
        await released.promise;
        return { compaction: f.result };
      });
      const before = f.manager.getPersistedEntries();
      const append = vi.spyOn(f.manager, "appendCompactionAsync");
      const attempt = f.session[agentSessionAutomaticCompaction](undefined, undefined, "none");
      const rejected = expect(attempt).rejects.toThrow(
        mode === "abort" ? "cancelled" : "retired fixture owner",
      );
      await awaitGateBeforeSettlement(
        entered.promise,
        attempt,
        "Prepared summary settled before its held effect",
      );
      if (mode === "abort") {
        f.session.abortCompaction();
      } else {
        active = false;
      }
      released.resolve();
      await rejected;
      expect(append).not.toHaveBeenCalled();
      expect(f.manager.getPersistedEntries()).toEqual(before);
      expect(f.publicBefore).toHaveBeenCalledOnce();
      expect(f.publicAfter).not.toHaveBeenCalled();
    },
  );
});

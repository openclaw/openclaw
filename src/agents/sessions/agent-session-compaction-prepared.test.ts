import { describe, expect, it, vi } from "vitest";
import {
  commitCompactionSummary,
  prepareCompactionFloor,
} from "../../../packages/agent-core/src/harness/compaction/compaction-floor.js";
import { compactWithoutSummary } from "../../../packages/agent-core/src/harness/compaction/compaction.js";
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
import {
  preparedSessionCompactionWork,
  type PreparedSessionCompactionWork,
} from "./compaction/prepared-work.js";
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
  const fallback = compactWithoutSummary(full.preparation);
  if (!fallback.ok) {
    throw fallback.error;
  }
  const first = branch.findIndex((entry) => entry.id === full.preparation.firstKeptEntryId);
  const header = original.getHeader();
  if (!header || first < 0) {
    throw new Error("Expected retained fixture suffix");
  }
  const manager = SessionManager.fromEntries([header, ...branch.slice(first)]);
  const publicBefore = vi.fn();
  const publicAfter = vi.fn();
  const { session } = await createTestSession({
    sessionManager: manager,
    settingsManager: settings,
    extension(api) {
      api.on("session_before_compact", publicBefore);
      api.on("session_compact", publicAfter);
    },
  });
  const result = {
    summary: "Prepared summary.",
    firstKeptEntryId: full.preparation.firstKeptEntryId,
    tokensBefore: full.preparation.tokensBefore,
  };
  const execute = vi
    .fn<PreparedSessionCompactionWork["execute"]>()
    .mockResolvedValue({ compaction: result });
  const deterministic = vi.fn(() => fallback);
  const work: PreparedSessionCompactionWork = {
    preparation: { ...full.preparation, messagesToSummarize: [], turnPrefixMessages: [] },
    requestBudget: full.requestBudget,
    requestTokenLimit: full.requestTokenLimit,
    floor: prepareCompactionFloor([
      ...full.preparation.messagesToSummarize,
      ...full.preparation.turnPrefixMessages,
    ]),
    deterministic,
    execute,
  };
  return {
    session,
    manager,
    full,
    result,
    work,
    execute,
    deterministic,
    publicBefore,
    publicAfter,
  };
}

describe("private prepared SDK compaction", () => {
  it.each(["summary", "deterministic", "required-cancellation"] as const)(
    "settles %s with the original floor and existing durable executor",
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
        {
          [preparedSessionCompactionWork]: f.work,
          ...(mode === "required-cancellation" ? { requestRequiresCompaction: true } : {}),
        },
      );
      expect(outcome.status).toBe("completed");
      if (outcome.status !== "completed") {
        throw new Error("Expected compaction receipt");
      }
      expect(f.publicBefore).not.toHaveBeenCalled();
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
        expect(f.deterministic).not.toHaveBeenCalled();
      } else {
        expect(f.deterministic).toHaveBeenCalledOnce();
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
      const attempt = f.session[agentSessionAutomaticCompaction](undefined, undefined, "none", {
        [preparedSessionCompactionWork]: f.work,
      });
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
      expect(f.publicBefore).not.toHaveBeenCalled();
      expect(f.publicAfter).not.toHaveBeenCalled();
    },
  );
});

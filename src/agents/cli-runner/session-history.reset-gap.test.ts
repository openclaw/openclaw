import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { SessionManager } from "../sessions/session-manager.js";
import { buildAssistantMessage, buildUsageWithNoCost } from "../stream-message-shared.js";
import { cliBackendLog } from "./log.js";
import { loadCliSessionPromptContext } from "./session-history.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    for (const stateDir of tempDirs.dirs) {
      await cleanupSessionStateForTest({ stateDir });
    }
    cleanup();
    clearRuntimeConfigSnapshot();
  });
});

async function createSession() {
  const dir = tempDirs.make("openclaw-cli-reset-gap-");
  setRuntimeConfigSnapshot({});
  const target = {
    agentId: "main",
    sessionId: "history-session",
    sessionKey: "agent:main:history",
    storePath: path.join(dir, "openclaw-agent.sqlite"),
  };
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  return {
    target,
    manager: await SessionManager.openAsync(target, dir),
    params: { sessionTarget: target },
  };
}

describe("Claude session gaps after a reset", () => {
  const assistant = (provider: string, timestamp: number) => ({
    ...buildAssistantMessage({
      model: { api: "cli", provider, id: "test-model" },
      content: [{ type: "text", text: "acknowledged" }],
      stopReason: "stop",
      usage: buildUsageWithNoCost({}),
    }),
    timestamp,
  });

  it.each([
    ["new", false],
    ["new", true],
    ["reset", false],
    ["reset", true],
  ] as const)("counts only post-/%s messages (memory=%s)", async (reason, memory) => {
    const { target, params, manager } = await createSession();
    const admission = prepareSystemAgentRunAdmission({}, `reset-gap-${reason}`, "main", "test");
    const admittedRunContext = await admission.admit("embedded");
    try {
      for (const [index, provider] of ["claude-cli", "mock"].entries()) {
        await manager.appendMessageAsync(
          makeUserMessage(`PRE-RESET-${index}`, index * 2000 + 1000),
        );
        await manager.appendMessageAsync(assistant(provider, index * 2000 + 2000));
      }
      await manager.appendResetBoundaryAsync(reason);
      const load = async (nativeSessionId?: string) =>
        (
          await loadCliSessionPromptContext({
            ...params,
            ...(memory ? { sessionManager: await SessionManager.openAsync(target) } : {}),
            sessionKey: target.sessionKey,
            sessionId: target.sessionId,
            admittedRunContext,
            provider: "claude-cli",
            nativeSessionId,
            rawTranscriptReseedReason: "auth-unknown",
            tools: [{ name: "sessions_history" }],
          })
        ).sessionGapContext;
      // The first turn after the reset has no earlier messages in this chat.
      await expect(load()).resolves.toBeUndefined();
      await manager.appendMessageAsync(makeUserMessage("POST-RESET", 5000));
      await manager.appendMessageAsync(assistant("mock", 6000));
      // Persisted row timestamps are wall-clock, so the window is asserted by count and models.
      const after =
        /^\[OpenClaw: 2 (earlier messages in this chat|messages occurred outside this Claude session) from \S+ to \S+, using "mock\/test-model"\. /;
      expect(await load()).toMatch(after);
      expect(await load()).toContain("earlier messages in this chat");
      if (!memory) {
        // A durable native session resumed across the reset counts the same closed window.
        expect(await load("native-session")).toMatch(after);
        expect(await load("native-session")).toContain("outside this Claude session");
      }
    } finally {
      admission.close();
    }
  });

  it("reports withheld raw history only when a fresh Claude session starts without it", async () => {
    const { target, params } = await createSession();
    const warn = vi.spyOn(cliBackendLog, "warn").mockImplementation(() => undefined);
    const load = (nativeSessionId?: string) =>
      loadCliSessionPromptContext({
        ...params,
        sessionKey: target.sessionKey,
        sessionId: target.sessionId,
        provider: "claude-cli",
        nativeSessionId,
        rawTranscriptReseedReason: "auth-unknown",
      });
    const refusals = () =>
      warn.mock.calls.filter(([message]) => message.startsWith("cli session history refused"));
    try {
      await load("native-session");
      expect(refusals()).toHaveLength(0);
      await load();
      expect(refusals()).toStrictEqual([
        ["cli session history refused across auth boundary: reason=auth-unknown"],
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps a retained reset prefix in the chat window", async () => {
    const { target, params, manager } = await createSession();
    const admission = prepareSystemAgentRunAdmission({}, "reset-gap-retained", "main", "test");
    const admittedRunContext = await admission.admit("embedded");
    try {
      await manager.appendMessageAsync(makeUserMessage("DROPPED", 1000));
      await manager.appendMessageAsync(assistant("mock", 2000));
      const kept = await manager.appendMessageAsync(makeUserMessage("RETAINED", 3000));
      await manager.appendMessageAsync(assistant("mock", 4000));
      await manager.appendResetBoundaryAsync("idle", kept);
      const context = await loadCliSessionPromptContext({
        ...params,
        sessionKey: target.sessionKey,
        sessionId: target.sessionId,
        admittedRunContext,
        provider: "claude-cli",
        rawTranscriptReseedReason: "auth-unknown",
      });
      expect(context.sessionGapContext).toMatch(
        /^\[OpenClaw: 2 earlier messages in this chat from \S+ to \S+, using "mock\/test-model"\. /,
      );
    } finally {
      admission.close();
    }
  });
});

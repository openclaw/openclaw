import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import * as workerAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import type { AgentMessage } from "../../runtime/index.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { createZeroUsageFixture } from "../../test-helpers/usage-fixtures.js";
import { stripSessionsYieldArtifacts } from "./attempt-sessions-yield.js";
import {
  normalizeCompactionRecoveryTranscriptTail,
  removeTrailingMidTurnPrecheckAssistantError,
} from "./attempt-transcript-helpers.js";
import { MidTurnPrecheckSignal } from "./midturn-precheck.js";

const MID_TURN_PRECHECK_ERROR_MESSAGE = new MidTurnPrecheckSignal({
  route: "compact_only",
  estimatedPromptTokens: 1100,
  promptBudgetBeforeReserve: 1000,
  overflowTokens: 100,
  toolResultReducibleChars: 0,
  effectiveReserveTokens: 100,
}).message;

function interceptTranscriptCommit(databasePath: string, onCommit: () => void) {
  const original = workerAdmission.createSqliteWorkerOperationAdmission;
  return vi
    .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
    .mockImplementation((admit, attachment) =>
      original((request, grant) => {
        if (
          request.stage === "commit" &&
          isRecord(request.facts) &&
          isRecord(request.facts.identity) &&
          request.facts.identity.nativeLocation === databasePath
        ) {
          onCommit();
        }
        admit(request, grant);
      }, attachment),
    );
}

it.each(["yield", "precheck", "compaction"])(
  "publishes %s recovery only after the transcript rewrite commits",
  async (recovery) => {
    await withOpenClawTestState({ label: "transcript-recovery" }, async (state) => {
      const target = {
        agentId: "main",
        sessionId: "recovery",
        sessionKey: "agent:main:recovery",
        storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      const sessionManager = await SessionManager.openAsync(target, state.workspaceDir);
      const user: AgentMessage = { role: "user", content: "continue", timestamp: 1 };
      const error: AgentMessage = {
        role: "assistant",
        content: [],
        api: "openai-responses",
        provider: "openai",
        model: "test-model",
        stopReason: "error",
        errorMessage: MID_TURN_PRECHECK_ERROR_MESSAGE,
        timestamp: 2,
        usage: createZeroUsageFixture(),
      };
      await sessionManager.appendMessageAsync(user);
      await sessionManager.appendMessageAsync(error);
      await sessionManager.appendCustomEntryAsync("preserved-state", { retained: true });
      const messages = [user, error];
      const activeSession = { messages, agent: { state: { messages } }, sessionManager };
      const cleanup = async () => {
        if (recovery === "yield") {
          await stripSessionsYieldArtifacts(activeSession);
        } else if (recovery === "precheck") {
          await removeTrailingMidTurnPrecheckAssistantError({ activeSession, sessionManager });
        } else {
          await normalizeCompactionRecoveryTranscriptTail({ activeSession, sessionManager });
        }
      };
      const refuseCommit = vi.fn(() => {
        throw new Error("recovery write failed");
      });
      const admission = interceptTranscriptCommit(target.storePath, refuseCommit);
      try {
        await expect(cleanup()).rejects.toThrow("recovery write failed");
      } finally {
        admission.mockRestore();
      }
      expect(refuseCommit).toHaveBeenCalled();
      expect(activeSession.agent.state.messages).toEqual(messages);
      expect(sessionManager.buildSessionContext().messages).toEqual(messages);
      await cleanup();
      expect(activeSession.agent.state.messages).toEqual([user]);
      expect((await SessionManager.openAsync(target)).buildSessionContext().messages).toEqual([
        user,
      ]);
      expect(sessionManager.getEntries()).toEqual(
        expect.arrayContaining([expect.objectContaining({ customType: "preserved-state" })]),
      );
    });
  },
);

it("keeps a mid-turn routing error out of durable history and resumes without a rewrite", async () => {
  await withOpenClawTestState({ label: "precheck-no-rewrite" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId: "precheck-no-rewrite",
      sessionKey: "agent:main:precheck-no-rewrite",
      storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
    const sessionManager = guardSessionManager(
      await SessionManager.openAsync(target, state.workspaceDir),
    );
    const user: AgentMessage = { role: "user", content: "continue", timestamp: 1 };
    await sessionManager.appendMessageAsync(user);
    const before = (await SessionManager.openAsync(target)).getEntries();
    const error: AgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      api: "openai-responses",
      provider: "openai",
      model: "test-model",
      stopReason: "error",
      errorMessage: MID_TURN_PRECHECK_ERROR_MESSAGE,
      timestamp: 2,
      usage: createZeroUsageFixture(),
    };
    await sessionManager.appendMessageAsync(error);
    expect((await SessionManager.openAsync(target)).getEntries()).toEqual(before);
    const activeSession = { agent: { state: { messages: [user, error] } } };
    const refuseCommit = vi.fn(() => {
      throw new Error("unexpected recovery write");
    });
    const admission = interceptTranscriptCommit(target.storePath, refuseCommit);
    try {
      await removeTrailingMidTurnPrecheckAssistantError({ activeSession, sessionManager });
    } finally {
      admission.mockRestore();
    }
    expect(refuseCommit).not.toHaveBeenCalled();
    expect(activeSession.agent.state.messages).toEqual([user]);
    expect((await SessionManager.openAsync(target)).getEntries()).toEqual(before);
    await sessionManager.appendMessageAsync({ ...error, errorMessage: "provider unavailable" });
    expect(
      (await SessionManager.openAsync(target)).buildSessionContext().messages.at(-1),
    ).toMatchObject({
      role: "assistant",
      errorMessage: "provider unavailable",
    });
  });
});

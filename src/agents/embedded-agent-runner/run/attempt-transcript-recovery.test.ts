import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import * as workerAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../../infra/sqlite-worker-owner-probe.test-support.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import type { AgentMessage } from "../../runtime/index.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { makeAgentAssistantMessage } from "../../test-helpers/agent-message-fixtures.js";
import { stripSessionsYieldArtifacts } from "./attempt-sessions-yield.js";
import {
  normalizeCompactionRecoveryTranscriptTail,
  removeTrailingMidTurnPrecheckAssistantError,
} from "./attempt-transcript-helpers.js";
import { MidTurnPrecheckSignal } from "./midturn-precheck.js";

const precheckError = new MidTurnPrecheckSignal({
  route: "compact_only",
  estimatedPromptTokens: 1100,
  promptBudgetBeforeReserve: 1000,
  overflowTokens: 100,
  toolResultReducibleChars: 0,
  effectiveReserveTokens: 100,
}).message;

it.each(["yield", "precheck", "compaction", "guarded-precheck"] as const)(
  "recovers %s without publishing ahead of durable history",
  async (mode) => {
    await withOpenClawTestState({ label: "transcript-recovery" }, async (state) => {
      const target = {
        agentId: "main",
        sessionId: "recovery",
        sessionKey: "agent:main:recovery",
        storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      const reopen = () => SessionManager.openAsync(target);
      const rawManager = await SessionManager.openAsync(target, state.workspaceDir);
      const guarded = mode === "guarded-precheck";
      const sessionManager = guarded ? guardSessionManager(rawManager) : rawManager;
      const user: AgentMessage = { role: "user", content: "continue", timestamp: 1 };
      await sessionManager.appendMessageAsync(user);
      const before = guarded ? (await reopen()).getEntries() : undefined;
      const error = makeAgentAssistantMessage({
        content: guarded ? [{ type: "text", text: "" }] : [],
        stopReason: "error",
        errorMessage: precheckError,
        timestamp: 2,
      });
      await sessionManager.appendMessageAsync(error);
      if (guarded) {
        expect((await reopen()).getEntries()).toEqual(before);
      } else {
        await sessionManager.appendCustomEntryAsync("preserved-state", { retained: true });
      }
      const messages = [user, error];
      const activeSession = { messages, agent: { state: { messages } }, sessionManager };
      const recovery = { activeSession, sessionManager };
      const cleanup = () =>
        mode === "yield"
          ? stripSessionsYieldArtifacts(activeSession)
          : mode === "compaction"
            ? normalizeCompactionRecoveryTranscriptTail(recovery)
            : removeTrailingMidTurnPrecheckAssistantError(recovery);
      const blocked = vi.fn(() => {
        throw new Error("recovery write failed");
      });
      const admission = probe.admission(workerAdmission, (request, grant, admit) => {
        const facts =
          isRecord(request.facts) && request.facts.kind === "session-manager-authority"
            ? request.facts.domainFacts
            : request.facts;
        if (
          request.stage === "commit" &&
          isRecord(facts) &&
          isRecord(facts.identity) &&
          facts.identity.nativeLocation === target.storePath
        ) {
          blocked();
        }
        admit(request, grant);
      });
      try {
        if (guarded) {
          await cleanup();
        } else {
          await expect(cleanup()).rejects.toThrow("recovery write failed");
        }
      } finally {
        admission.mockRestore();
      }
      expect(blocked.mock.calls.length > 0).toBe(!guarded);
      expect(activeSession.agent.state.messages).toEqual(guarded ? [user] : messages);
      if (guarded) {
        expect((await reopen()).getEntries()).toEqual(before);
        await sessionManager.appendMessageAsync({ ...error, errorMessage: "provider unavailable" });
        expect((await reopen()).buildSessionContext().messages.at(-1)).toMatchObject({
          role: "assistant",
          errorMessage: "provider unavailable",
        });
      } else {
        expect(sessionManager.buildSessionContext().messages).toEqual(messages);
        await cleanup();
        expect(activeSession.agent.state.messages).toEqual([user]);
        expect((await reopen()).buildSessionContext().messages).toEqual([user]);
        expect(sessionManager.getEntries()).toContainEqual(
          expect.objectContaining({ customType: "preserved-state" }),
        );
      }
    });
  },
);

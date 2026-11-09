import path from "node:path";
import { expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import type { Context } from "../../../llm/types.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { readModelPromptProjection } from "../../../sessions/user-turn-transcript.message.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { NativeHistoryAuthorizationChangedError } from "../../native-history-authorization-error.js";
import { guardSessionManager } from "../../session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "../../sessions/agent-session-loop-correctness.test-support.js";
import { withSessionManagerWrite } from "../../sessions/session-manager-write-admission.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import { createBaseInput } from "./attempt-prompt-submit.test-support.js";

registerAgentSessionLoopTestLifecycle();

it.each([false, true])(
  "rechecks private context after request preparation (revoked=%s)",
  async (revoked) => {
    const requests: Context["messages"][] = [];
    streamMocks.streamSimple.mockImplementation((model, context) => {
      requests.push(structuredClone(context.messages));
      return createAssistantResultStream(createAssistant(model, "done"));
    });
    const { session } = await createTestSession();
    let authorized = true;
    const input = createBaseInput();
    Object.assign(input.attempt, {
      assertPrivateInputCurrent: () => {
        if (!authorized) {
          throw new NativeHistoryAuthorizationChangedError();
        }
      },
    });
    try {
      const submission = submitEmbeddedAttemptPrompt({
        ...input,
        activeSession: session,
        transcriptPrompt: "Current request",
        modelPrompt: "Private native history\nCurrent request",
        prependContext: "",
        appendContext: "",
        onModelRequest: async () => {
          await Promise.resolve();
          authorized = !revoked;
          return undefined;
        },
        promptActiveSession: (prompt, options) => session.prompt(prompt, options),
      });
      if (revoked) {
        await expect(submission).rejects.toBeInstanceOf(NativeHistoryAuthorizationChangedError);
      } else {
        await submission;
      }
      expect(requests).toHaveLength(revoked ? 0 : 1);
      if (!revoked) {
        expect(JSON.stringify(requests)).toContain("Private native history");
      }
    } finally {
      session.dispose();
    }
  },
);

it.each([true, false])(
  "uses canonical capture as the private-input commitment (revoked before capture=%s)",
  async (beforeCapture) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const target = {
        agentId: "main",
        sessionId: "private-projection",
        sessionKey: "agent:main:private-projection",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
      const manager = await SessionManager.openAsync(target, state.workspaceDir);
      const recorder = createUserTurnTranscriptRecorder({
        input: { text: "Current request", timestamp: 1, idempotencyKey: "private-projection:user" },
        target: { ...target, sessionEntry: { sessionId: target.sessionId, updatedAt: 1 } },
      });
      const wait = recorder.waitForRuntimePersistence.bind(recorder);
      let authorized = true;
      vi.spyOn(recorder, "waitForRuntimePersistence").mockImplementation(async () => {
        await wait();
        if (beforeCapture) {
          authorized = false;
        }
      });
      const requests: Context["messages"][] = [];
      streamMocks.streamSimple.mockImplementation((model, context) => {
        requests.push(structuredClone(context.messages));
        return createAssistantResultStream(createAssistant(model, "done"));
      });
      const capture = vi.spyOn(recorder, "captureModelPromptProjection");
      guardSessionManager(manager, {
        preparedUserTurnMessage: recorder.message,
        preparedUserTurnTranscriptRecorder: recorder,
      });
      const { session } = await createTestSession({ sessionManager: manager });
      const input = createBaseInput();
      input.attempt = Object.assign(input.attempt, {
        ...target,
        userTurnTranscriptRecorder: recorder,
        assertPrivateInputCurrent: () => {
          if (!authorized) {
            throw new NativeHistoryAuthorizationChangedError();
          }
        },
      });
      const submit = () =>
        submitEmbeddedAttemptPrompt({
          ...input,
          activeSession: session,
          transcriptPrompt: "Current request",
          modelPrompt: "Private native history\nCurrent request",
          prependContext: "",
          appendContext: "",
          withTranscriptWrite: (write) => withSessionManagerWrite(manager, write),
          onModelRequest: async () => {
            authorized = false;
            return undefined;
          },
          promptActiveSession: (prompt, options) => session.prompt(prompt, options),
        });
      try {
        if (beforeCapture) {
          await expect(submit()).rejects.toBeInstanceOf(NativeHistoryAuthorizationChangedError);
          expect(capture).not.toHaveBeenCalled();
          expect(readModelPromptProjection(recorder.getPersistedMessage?.())).toBeUndefined();
          expect(requests).toHaveLength(0);
        } else {
          await submit();
          expect(capture).toHaveBeenCalledOnce();
          expect(readModelPromptProjection(recorder.getPersistedMessage?.())).toContain(
            "Private native history",
          );
          expect(requests).toHaveLength(1);
          expect(authorized).toBe(false);
          Object.assign(input.attempt, { suppressNextUserMessagePersistence: true });
          await submit();
          expect(requests).toHaveLength(2);
          expect(capture).toHaveBeenCalledOnce();
        }
      } finally {
        session.dispose();
      }
    });
  },
);

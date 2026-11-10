import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it } from "vitest";
import type { MsgContext } from "../../../auto-reply/templating.js";
import { setRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import {
  parseMessageWithAttachments,
  persistInboundImagesForTranscript,
} from "../../../gateway/chat-attachments.js";
import type { Context } from "../../../llm/types.js";
import { applyMediaUnderstanding } from "../../../media-understanding/apply.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import { readModelPromptProjection } from "../../../sessions/user-turn-transcript.message.js";
import { readTranscriptMessages } from "../../../sessions/user-turn-transcript.test-support.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
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
import { clearEmbeddedSessionPromptStates } from "../session-prompt-state.js";
import { normalizeMessagesForLlmBoundary } from "./attempt-llm-boundary.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import { createBaseInput, sessionId } from "./attempt-prompt-submit.test-support.js";
import { createUserTranscriptContextRegistry } from "./attempt-user-transcript-context-registry.js";

registerAgentSessionLoopTestLifecycle();
afterEach(() => clearEmbeddedSessionPromptStates([sessionId]));

// Exercise ingestion, extraction, durable transcript and provider dispatch without a Gateway boot.
it("retains pasted text attachments in later provider requests and reopened sessions", async () => {
  await withOpenClawTestState({ label: "pasted-text-projection" }, async (state) => {
    const target = {
      agentId: "main",
      sessionId,
      sessionKey: "agent:main:pasted-text-projection",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    setRuntimeConfigSnapshot({});
    await upsertSessionEntryCore(target, { sessionId, updatedAt: 1 });
    const pasted =
      "The emergency access phrase is cobalt-orchard-731.\n" +
      "Ordinary background context.\n".repeat(50);
    const caption = "Use these notes for my questions.";
    const parsed = await parseMessageWithAttachments(caption, [
      {
        type: "file",
        mimeType: "text/plain",
        fileName: "pasted-text-123.txt",
        origin: "paste",
        content: Buffer.from(pasted).toString("base64"),
      },
    ]);
    const saved = await persistInboundImagesForTranscript({
      images: parsed.images,
      offloadedRefs: parsed.offloadedRefs,
      log: { warn: () => {} },
      logContext: "pasted-text-test",
    });
    const ctx: MsgContext = {
      Body: parsed.message,
      BodyForAgent: parsed.message,
      RawBody: parsed.message,
      media: parsed.media,
    };
    await applyMediaUnderstanding({
      ctx,
      cfg: {},
      workspaceDir: state.workspaceDir,
      processingMode: "files-only",
    });
    const enriched = expectDefined(ctx.agentText, "extracted attachment prompt");
    expect(enriched).toContain(pasted.trim());
    const requests: Context["messages"][] = [];
    streamMocks.streamSimple.mockImplementation((model, context) => {
      requests.push(structuredClone(context.messages));
      // Do not echo the fact: only the original user turn can carry it forward.
      return createAssistantResultStream(createAssistant(model, "Acknowledged."));
    });
    const open = async () => {
      const manager = await SessionManager.openAsync(target, state.workspaceDir);
      const { session } = await createTestSession({ sessionManager: manager });
      const contexts = createUserTranscriptContextRegistry();
      const convert = session.agent.convertToLlm;
      session.agent.convertToLlm = (messages) =>
        convert(
          normalizeMessagesForLlmBoundary(messages, {
            userTranscriptContexts: contexts.list(),
            includeTimestamp: false,
          }),
        );
      return { manager, session, contexts };
    };
    const send = async (active: Awaited<ReturnType<typeof open>>, turn: number) => {
      const recorder = createUserTurnTranscriptRecorder({
        input: {
          text: turn === 1 ? caption : "What was the emergency access phrase?",
          timestamp: turn,
          idempotencyKey: "paste:" + turn,
          ...(turn === 1 ? { media: saved.entries.map((entry) => entry.fact) } : {}),
        },
        target: { ...target, sessionEntry: { sessionId, updatedAt: 1 } },
      });
      // chat.send acknowledges the durable user row before dispatch starts.
      await recorder.persistApproved();
      await active.manager.reloadPersistedTranscriptAsync();
      guardSessionManager(active.manager, {
        suppressNextUserMessagePersistence: true,
        preparedUserTurnMessage: recorder.message,
        preparedUserTurnTranscriptRecorder: recorder,
        onUserMessagePersisted: (message, runtimeMessage) => {
          if (runtimeMessage) {
            active.contexts.record(runtimeMessage, message);
          }
        },
      });
      const prompt = turn === 1 ? enriched : "What was the emergency access phrase?";
      await submitEmbeddedAttemptPrompt({
        ...createBaseInput(),
        attempt: { sessionId, userTurnTranscriptRecorder: recorder },
        activeSession: active.session,
        transcriptPrompt: prompt,
        modelPrompt: prompt,
        prependContext: undefined,
        appendContext: undefined,
        getUserTranscriptContexts: () => active.contexts.list(),
        withTranscriptWrite: (write) => withSessionManagerWrite(active.manager, write),
        promptActiveSession: (text, options) => active.session.prompt(text, options),
      });
    };
    const first = await open();
    await send(first, 1);
    await send(first, 2);
    first.session.dispose();
    const reopened = await open();
    await send(reopened, 3);
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      const original = request.find((message) => message.role === "user");
      expect(JSON.stringify(original)).toContain(JSON.stringify(pasted.trim()).slice(1, -1));
      expect(original).toEqual(requests[0]?.find((message) => message.role === "user"));
    }
    const stored = (await readTranscriptMessages(target)).find(
      (message) => message.role === "user",
    );
    expect(stored).toMatchObject({
      content: caption,
      __openclaw: {
        media: [expect.objectContaining({ origin: "paste", fileName: "pasted-text-123.txt" })],
      },
    });
    expect(readModelPromptProjection(stored)).toContain(pasted.trim());
  });
});

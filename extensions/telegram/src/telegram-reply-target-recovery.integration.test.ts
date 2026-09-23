import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildEmbeddedRunPayloads,
  subscribeEmbeddedAgentSession,
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import type { PluginHookReplyPayloadSendingEvent } from "openclaw/plugin-sdk/core";
import type { Model } from "openclaw/plugin-sdk/llm";
import {
  createHookRunner,
  addTestHook,
  createEmptyPluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeQaRuntimeStores } from "openclaw/plugin-sdk/qa-runtime";
import {
  buildReplyPayloads,
  captureReplyDispatchDeliveryOutcome,
  runReplyPayloadSendingHook,
  createReplyToModeFilterForChannel,
} from "openclaw/plugin-sdk/reply-payload-testing";
import { createReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { patchSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { expect, it, vi } from "vitest";
import {
  createContext,
  describeTelegramDispatch,
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchWithContext,
  readLatestAssistantTextByIdentity,
  telegramDepsForTest,
} from "./bot-message-dispatch.test-harness.js";
import { telegramReplyTarget, withTelegramReplyApi } from "./telegram-reply-api.test-helpers.js";
const realTelegram = await vi.importActual<typeof import("./bot/delivery.replies.js")>(
  "./bot/delivery.replies.js",
);
registerAgentSessionLoopTestLifecycle();
const firstText =
  "The first queued answer completes its request and remains visible in the conversation.";
const prefix = "The latest queued answer preserves this long source-backed opening paragraph";
const fullText =
  prefix +
  " and continues with all of the required details that demonstrate a qualifying transcript recovery.";
describeTelegramDispatch("consumed first target and latest transcript recovery", () => {
  it.each([
    { mode: "first", shorten: false },
    { mode: "first", shorten: true },
    { mode: "batched", shorten: true },
    { mode: "all", shorten: true },
  ] as const)("$mode / shortened=$shorten", async ({ mode, shorten }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "consumed-target-recovery-"));
    const scope = {
      agentId: "default",
      sessionId: "consumed-recovery",
      sessionKey: "agent:default:telegram:direct:123",
      storePath: path.join(root, "sessions.json"),
    };
    const entry = { sessionId: scope.sessionId, updatedAt: Date.now() };
    const rewrittenFinals: string[] = [];
    const settled: unknown[] = [];
    const deliveryErrors: string[] = [];
    let disposeSession: (() => void) | undefined;
    await withTelegramReplyApi(async ({ bot, calls: native }) => {
      try {
        await patchSessionEntry({ ...scope, fallbackEntry: entry, update: () => entry });
        const manager = SessionManager.open(scope, root);
        const transcript = await vi.importActual<
          typeof import("openclaw/plugin-sdk/session-transcript-runtime")
        >("openclaw/plugin-sdk/session-transcript-runtime");
        readLatestAssistantTextByIdentity.mockImplementation(
          transcript.readLatestAssistantTextByIdentity,
        );
        dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
          async ({ dispatcherOptions }) => {
            const { session } = await createTestSession({ sessionManager: manager });
            disposeSession = () => session.dispose();
            let calls = 0;
            streamMocks.streamSimple.mockImplementation((model: Model) => {
              calls += 1;
              if (calls === 1) {
                void session.followUp("Answer the queued second request.");
              }
              return createAssistantResultStream(
                createAssistant(model, [
                  {
                    type: "text",
                    text: "[[reply_to_current]]" + (calls === 1 ? firstText : fullText),
                  },
                ]),
              );
            });
            const subscription = subscribeEmbeddedAgentSession({
              session,
              runId: "consumed-target-recovery",
            });
            try {
              await session.prompt("Answer the first request.");
              await subscription.waitForPendingEvents();
              const captured = subscription.getCurrentAttemptAssistant();
              const embedded = buildEmbeddedRunPayloads({
                assistantTexts: subscription.assistantTexts,
                answerSegments: subscription.answerSegments,
                lastAssistant: captured,
                currentAssistant: captured ?? null,
                sessionKey: scope.sessionKey,
              });
              const applyReplyToMode = createReplyToModeFilterForChannel(mode, "telegram");
              const { replyPayloads } = await buildReplyPayloads({
                applyReplyToMode,
                payloads: embedded,
                isHeartbeat: false,
                didLogHeartbeatStrip: false,
                blockStreamingEnabled: false,
                blockReplyPipeline: null,
                replyToMode: mode,
                replyToChannel: "telegram",
                currentMessageId: "456",
              });
              expect(
                manager
                  .getEntries()
                  .filter((e) => e.type === "message" && e.message.role === "assistant"),
              ).toHaveLength(2);
              expect(calls).toBe(2);
              const registry = createEmptyPluginRegistry();
              addTestHook({
                registry,
                pluginId: "bounded-recovery-probe",
                hookName: "reply_payload_sending",
                handler: (event: PluginHookReplyPayloadSendingEvent) => {
                  if (event.kind !== "final" || event.payload.text !== fullText || !shorten) {
                    return undefined;
                  }
                  const text = prefix + "...";
                  rewrittenFinals.push(text);
                  return { payload: { ...event.payload, text } };
                },
              });
              const runner = createHookRunner(registry);
              const dispatcher = createReplyDispatcher({
                ...dispatcherOptions,
                onError: (error) => {
                  deliveryErrors.push(String(error));
                },
                beforeDeliver: (payload, info) =>
                  runReplyPayloadSendingHook(
                    {
                      payload,
                      kind: info.kind,
                      channel: "telegram",
                      sessionKey: scope.sessionKey,
                      context: { channelId: "telegram", conversationId: "123" },
                    },
                    runner,
                  ),
              });
              try {
                for (const payload of replyPayloads) {
                  const capture = captureReplyDispatchDeliveryOutcome(payload);
                  expect(dispatcher.sendFinalReply(payload)).toBe(true);
                  const outcome = await capture.promise;
                  settled.push(outcome);
                  expect(outcome).toBe("delivered");
                }
              } finally {
                dispatcher.markComplete();
                await dispatcher.waitForIdle();
              }
              return { queuedFinal: true, counts: dispatcher.getQueuedCounts() };
            } finally {
              await subscription.waitForPendingEvents();
              subscription.unsubscribe();
            }
          },
        );
        const context = createContext();
        context.ctxPayload.SessionKey = scope.sessionKey;
        context.ctxPayload.MessageSid = "456";
        await dispatchWithContext({
          context,
          bot,
          replyToMode: mode,
          streamMode: "off",
          telegramDeps: {
            ...telegramDepsForTest,
            resolveStorePath: () => scope.storePath,
            getSessionEntry: () => entry,
            deliverReplies: realTelegram.deliverReplies,
            deliverStructuredReplies: realTelegram.deliverStructuredReplies,
            deliverStructuredInboundReplyWithMessageSendContext: undefined,
          },
        });
        const sends = native.filter(
          (x) => x.method === "sendMessage" || x.method === "sendRichMessage",
        );
        const targets = sends.map(telegramReplyTarget);
        expect(deliveryErrors).toEqual([]);
        expect(settled).toEqual(["delivered", "delivered"]);
        expect(rewrittenFinals).toEqual(shorten ? [prefix + "..."] : []);
        expect(native.some((x) => x.method === "deleteMessage")).toBe(false);
        expect(sends.map((s) => s.fields.text)).toEqual([firstText, fullText]);
        expect(targets).toEqual(mode === "all" ? [456, 456] : [456, null]);
      } finally {
        disposeSession?.();
        await closeQaRuntimeStores(root);
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });
});

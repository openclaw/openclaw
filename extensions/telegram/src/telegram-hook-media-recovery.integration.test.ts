import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
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
import { collectReplyMediaEntries } from "openclaw/plugin-sdk/channel-outbound";
import type { PluginHookReplyPayloadSendingEvent } from "openclaw/plugin-sdk/core";
import type { Model } from "openclaw/plugin-sdk/llm";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-local-roots";
import {
  createHookRunner,
  addTestHook,
  createEmptyPluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeQaRuntimeStores } from "openclaw/plugin-sdk/qa-runtime";
import {
  buildReplyPayloads,
  createReplyTurnLedger,
  createReplyMediaContext,
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
const prefix = "The complete answer preserves this sufficiently long opening paragraph";
const fullText =
  prefix +
  " and continues with the remaining details required to establish legitimate transcript text recovery.";

describeTelegramDispatch("hook media selection during transcript recovery", () => {
  it.each([
    { selection: "unchanged-empty", mediaCount: 0 },
    { selection: "unchanged-media", mediaCount: 1 },
    { selection: "remove", mediaCount: 1 },
    { selection: "reorder-subset", mediaCount: 3 },
    { selection: "later-replacement", mediaCount: 1 },
  ] as const)("preserves $selection during recovery", async ({ selection, mediaCount }) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hook-media-recovery-"));
    const workspace = path.join(root, "workspace");
    const sources = ["A", "B", "C"].map((name) => path.join(workspace, name + ".txt"));
    const replacement = path.join(workspace, "D.txt");
    const authoredSources = sources.slice(0, mediaCount);
    const laterSelections: number[] = [];
    const oldStateDir = process.env.OPENCLAW_STATE_DIR;
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    const scope = {
      agentId: "default",
      sessionId: "hook-media-recovery",
      sessionKey: "agent:default:telegram:direct:123",
      storePath: path.join(root, "sessions.json"),
    };
    const entry = { sessionId: scope.sessionId, updatedAt: Date.now() };
    const cfg = {
      agents: {
        defaults: { sandbox: { mode: "off" as const } },
        entries: { default: { workspace } },
      },
    };
    const receipts: Array<{
      inputMedia: number;
      outputMedia: number;
      staged: boolean;
      text: string;
    }> = [];
    const settled: Array<string | undefined> = [];
    const errors: string[] = [];
    let disposeSession: (() => void) | undefined;
    try {
      await fs.mkdir(workspace, { recursive: true });
      for (const file of [...sources, replacement]) {
        await fs.writeFile(file, "Document " + path.basename(file, ".txt") + "\n");
      }
      await patchSessionEntry({ ...scope, fallbackEntry: entry, update: () => entry });
      const manager = SessionManager.open(scope, root);
      const transcript = await vi.importActual<
        typeof import("openclaw/plugin-sdk/session-transcript-runtime")
      >("openclaw/plugin-sdk/session-transcript-runtime");
      readLatestAssistantTextByIdentity.mockImplementation(
        transcript.readLatestAssistantTextByIdentity,
      );
      const telegramRuntime = await import("./bot-message-dispatch.runtime.js");
      vi.mocked(telegramRuntime.getAgentScopedMediaLocalRoots).mockImplementation(
        getAgentScopedMediaLocalRoots,
      );
      await withTelegramReplyApi(async ({ bot, calls }) => {
        dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
          async ({ dispatcherOptions }) => {
            const { session } = await createTestSession({ sessionManager: manager });
            disposeSession = () => session.dispose();
            streamMocks.streamSimple.mockImplementation((model: Model) =>
              createAssistantResultStream(
                createAssistant(model, [
                  {
                    type: "text",
                    text:
                      fullText +
                      authoredSources.map((source) => "\n\nMEDIA:" + source).join("") +
                      "\n\n[[reply_to_current]]",
                  },
                ]),
              ),
            );
            const subscription = subscribeEmbeddedAgentSession({
              session,
              runId: "hook-media-recovery",
            });
            const registry = createEmptyPluginRegistry();
            addTestHook({
              registry,
              pluginId: "media-selection",
              hookName: "reply_payload_sending",
              priority: 10,
              handler: (event: PluginHookReplyPayloadSendingEvent) => {
                if (event.kind !== "final" || event.payload.text !== fullText) {
                  return undefined;
                }
                const input = [
                  ...new Set([
                    ...(event.payload.mediaUrls ?? []),
                    ...(event.payload.mediaUrl ? [event.payload.mediaUrl] : []),
                  ]),
                ];
                const selected =
                  selection === "reorder-subset"
                    ? [expectDefined(input[2], "Media C"), expectDefined(input[0], "Media A")]
                    : [];
                const payload =
                  selection === "unchanged-media"
                    ? { ...event.payload, text: prefix + "..." }
                    : {
                        ...event.payload,
                        text: prefix + "...",
                        mediaUrl: undefined,
                        mediaUrls: selected,
                        attachments: collectReplyMediaEntries(event.payload, selected).map(
                          ({ attachment }) => attachment ?? {},
                        ),
                      };
                receipts.push({
                  inputMedia: input.length,
                  outputMedia: payload.mediaUrls?.length ?? 0,
                  staged: input.length > 0 && input.every((url) => !authoredSources.includes(url)),
                  text: payload.text,
                });
                return { payload };
              },
            });
            addTestHook({
              registry,
              pluginId: "later-media-selection",
              hookName: "reply_payload_sending",
              handler: (event: PluginHookReplyPayloadSendingEvent) => {
                if (
                  selection !== "later-replacement" ||
                  event.kind !== "final" ||
                  event.payload.text !== prefix + "..."
                ) {
                  return undefined;
                }
                laterSelections.push(event.payload.mediaUrls?.length ?? 0);
                return {
                  payload: {
                    ...event.payload,
                    mediaUrl: undefined,
                    mediaUrls: [replacement],
                    attachments: [{ path: replacement, name: "D.txt" }],
                  },
                };
              },
            });
            const runner = createHookRunner(registry);
            const dispatcher = createReplyDispatcher({
              ...dispatcherOptions,
              onError: (error) => {
                errors.push(String(error));
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
            const ledger = createReplyTurnLedger(dispatcher);
            try {
              await session.prompt("Return the synthetic final answer and requested document.");
              await subscription.waitForPendingEvents();
              const assistant = subscription.getCurrentAttemptAssistant();
              const embedded = buildEmbeddedRunPayloads({
                assistantTexts: subscription.assistantTexts,
                answerSegments: subscription.answerSegments,
                lastAssistant: assistant,
                currentAssistant: assistant ?? null,
                sessionKey: scope.sessionKey,
              });
              const media = createReplyMediaContext({
                cfg,
                agentId: "default",
                workspaceDir: workspace,
                sessionKey: scope.sessionKey,
                messageProvider: "telegram",
              });
              const { replyPayloads } = await buildReplyPayloads({
                config: cfg,
                payloads: embedded,
                isHeartbeat: false,
                didLogHeartbeatStrip: false,
                blockStreamingEnabled: false,
                blockReplyPipeline: null,
                applyReplyToMode: createReplyToModeFilterForChannel("off", "telegram"),
                replyToMode: "off",
                replyToChannel: "telegram",
                currentMessageId: "456",
                normalizeMediaPaths: media.normalizePayload,
              });
              const persisted = await transcript.readLatestAssistantTextByIdentity(scope);
              expect(persisted?.text).toContain(fullText);
              for (const source of authoredSources) {
                expect(persisted?.text).toContain("MEDIA:" + source);
              }
              for (const payload of replyPayloads) {
                const send = ledger.sendQueued("final", payload);
                expect(send.queued).toBe(true);
                settled.push(await send.outcome);
              }
              return { queuedFinal: true, counts: dispatcher.getQueuedCounts() };
            } finally {
              await subscription.waitForPendingEvents();
              subscription.unsubscribe();
              dispatcher.markComplete();
              await dispatcher.waitForIdle();
            }
          },
        );
        const context = createContext();
        context.ctxPayload.SessionKey = scope.sessionKey;
        context.ctxPayload.MessageSid = "456";
        await dispatchWithContext({
          context,
          bot,
          cfg,
          replyToMode: "off",
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
        expect(errors).toEqual([]);
        expect(settled).toEqual(["delivered"]);
        expect(receipts).toEqual([
          {
            inputMedia: mediaCount,
            outputMedia:
              selection === "reorder-subset" ? 2 : selection === "unchanged-media" ? 1 : 0,
            staged: mediaCount > 0,
            text: prefix + "...",
          },
        ]);
        const expectedDocuments =
          selection === "reorder-subset"
            ? ["Document C\n", "Document A\n"]
            : selection === "later-replacement"
              ? ["Document D\n"]
              : selection === "unchanged-media"
                ? ["Document A\n"]
                : [];
        const documents = calls.filter((call) => call.method === "sendDocument");
        expect(documents.map((call) => call.files[0]?.content.toString("utf8"))).toEqual(
          expectedDocuments,
        );
        expect(laterSelections).toEqual(selection === "later-replacement" ? [0] : []);
        const messages = calls.filter(
          (call) =>
            (call.method === "sendMessage" || call.method === "sendDocument") &&
            (call.fields.text || call.fields.caption),
        );
        expect(messages.map((call) => call.fields.text ?? call.fields.caption)).toEqual([fullText]);
        expect(messages.map(telegramReplyTarget)).toEqual([456]);
      });
    } finally {
      disposeSession?.();
      await closeQaRuntimeStores(root);
      await fs.rm(root, { recursive: true, force: true });
      if (oldStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = oldStateDir;
      }
    }
  });
});

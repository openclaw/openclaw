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
  createReadToolDefinition,
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
  setBlockReplyDelivery,
  createReplyTurnLedger,
  createBlockReplyDeliveryHandler,
  type DirectBlockDelivery,
  createReplyMediaContext,
  runReplyPayloadSendingHook,
  createReplyToModeFilterForChannel,
  createTypingSignaler,
  createTypingController,
} from "openclaw/plugin-sdk/reply-payload-testing";
import { createReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { patchSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { expect, it, vi } from "vitest";
import { deduplicateBlockSentMedia } from "./bot-message-dispatch.media-dedup.js";
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
const caption = "MEDIA-ALIAS-PROBE-DOCUMENT";
const prefix = "The complete media explanation retains its original delivery context";
const fullText =
  prefix +
  " and continues with the remaining details after the document. This complete final must arrive as one targeted text message without sending the already delivered document again. MEDIA-ALIAS-PROBE-DONE";

describeTelegramDispatch("staged media identity through persisted final recovery", () => {
  it("keeps the first document out of the recovered targeted text final", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "media-alias-recovery-"));
    const workspace = path.join(root, "workspace");
    const sourcePath = path.join(workspace, "prepared-delivery-note.txt");
    const originalStateDir = process.env.OPENCLAW_STATE_DIR;
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(sourcePath, "Synthetic prepared delivery note.\n");
    await fs.writeFile(
      path.join(workspace, "QA_KICKOFF_TASK.md"),
      "Read-only continuation for synthetic media proof.\n",
    );
    const scope = {
      agentId: "default",
      sessionId: "media-alias-recovery",
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
    expect(getAgentScopedMediaLocalRoots(cfg, "default")).toContain(workspace);
    const receipts: Array<Record<string, unknown>> = [];
    const deliveryErrors: string[] = [];
    const finalOutcomes: string[] = [];
    const directBlockDeliveries: DirectBlockDelivery[] = [];
    let disposeSession: (() => void) | undefined;
    await withTelegramReplyApi(async ({ bot, calls: native }) => {
      try {
        await patchSessionEntry({ ...scope, fallbackEntry: entry, update: () => entry });
        const telegramRuntime = await import("./bot-message-dispatch.runtime.js");
        vi.mocked(telegramRuntime.getAgentScopedMediaLocalRoots).mockImplementation(
          getAgentScopedMediaLocalRoots,
        );
        const manager = SessionManager.open(scope, root);
        const transcript = await vi.importActual<
          typeof import("openclaw/plugin-sdk/session-transcript-runtime")
        >("openclaw/plugin-sdk/session-transcript-runtime");
        readLatestAssistantTextByIdentity.mockImplementation(
          transcript.readLatestAssistantTextByIdentity,
        );
        dispatchReplyWithBufferedBlockDispatcher.mockImplementation(
          async ({ dispatcherOptions }) => {
            const registry = createEmptyPluginRegistry();
            addTestHook({
              registry,
              pluginId: "media-alias-probe",
              hookName: "reply_payload_sending",
              handler: async (event: PluginHookReplyPayloadSendingEvent) => {
                if (event.payload.text?.trimEnd() !== fullText) {
                  return undefined;
                }
                const media = [
                  ...new Set([
                    ...(event.payload.mediaUrls ?? []),
                    ...(event.payload.mediaUrl ? [event.payload.mediaUrl] : []),
                  ]),
                ];
                if (event.kind === "block") {
                  expect(media).toHaveLength(1);
                  expect(
                    await fs.readFile(expectDefined(media[0], "Cancelled block media")),
                  ).toEqual(await fs.readFile(sourcePath));
                  receipts.push({
                    phase: "cancelled-full-block",
                    mediaCount: media.length,
                    usesOriginalPath: media[0] === sourcePath,
                  });
                  return { cancel: true };
                }
                if (event.kind !== "final") {
                  return undefined;
                }
                expect(media).toHaveLength(0);
                const payload = { ...event.payload, text: prefix + "..." };
                delete payload.replyToId;
                delete payload.replyToCurrent;
                delete payload.replyToTag;
                receipts.push({
                  phase: "shortened-final",
                  mediaCount: media.length,
                  hadTarget: Boolean(event.payload.replyToId || event.payload.replyToCurrent),
                  outputHasTarget: Boolean(
                    payload.replyToId || payload.replyToCurrent || payload.replyToTag,
                  ),
                });
                return { payload };
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
            const ledger = createReplyTurnLedger(dispatcher);
            const typing = createTypingController({});
            const media = createReplyMediaContext({
              cfg,
              agentId: "default",
              workspaceDir: workspace,
              sessionKey: scope.sessionKey,
              messageProvider: "telegram",
            });
            const handleBlock = createBlockReplyDeliveryHandler({
              onBlockReply: async (payload) => {
                const send = ledger.sendQueued("block", payload);
                expect(send.queued).toBe(true);
                const pendingOutcome = expectDefined(send.outcome, "Queued block outcome");
                setBlockReplyDelivery(
                  pendingOutcome.then((outcome) => ({
                    outcome,
                    pending: send.hasPendingDelivery?.(),
                  })),
                  payload,
                );
              },
              currentMessageId: "456",
              replyThreading: { implicitCurrentMessage: "deny" },
              normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
              applyReplyToMode: createReplyToModeFilterForChannel("off", "telegram"),
              normalizeMediaPaths: media.normalizePayload,
              typingSignals: createTypingSignaler({ typing, mode: "never", isHeartbeat: false }),
              blockStreamingEnabled: false,
              blockReplyPipeline: null,
              directBlockDeliveries,
            });
            const blockTasks: Promise<void>[] = [];
            const { session } = await createTestSession({
              sessionManager: manager,
              customTools: [createReadToolDefinition(workspace)],
            });
            disposeSession = () => session.dispose();
            let calls = 0;
            streamMocks.streamSimple.mockImplementation((model: Model) => {
              calls++;
              return createAssistantResultStream(
                calls === 1
                  ? createAssistant(
                      model,
                      [
                        { type: "text", text: caption + "\n\nMEDIA:" + sourcePath },
                        {
                          type: "toolCall",
                          id: "media-proof-read",
                          name: "read",
                          arguments: { path: "QA_KICKOFF_TASK.md" },
                        },
                      ],
                      "toolUse",
                    )
                  : createAssistant(model, [
                      {
                        type: "text",
                        text: fullText + "\n\nMEDIA:" + sourcePath + "\n\n[[reply_to_current]]",
                      },
                    ]),
              );
            });
            const subscription = subscribeEmbeddedAgentSession({
              session,
              runId: "media-alias-recovery",
              blockReplyBreak: "message_end",
              onBlockReply: (payload) => {
                const pending = handleBlock(payload);
                blockTasks.push(pending);
                return pending;
              },
            });
            try {
              await session.prompt(
                "Deliver the synthetic document, read the task file, and complete the final explanation.",
              );
              await subscription.waitForPendingEvents();
              await Promise.all(blockTasks);
              const assistant = subscription.getCurrentAttemptAssistant();
              const embedded = buildEmbeddedRunPayloads({
                assistantTexts: subscription.assistantTexts,
                answerSegments: subscription.answerSegments,
                lastAssistant: assistant,
                currentAssistant: assistant ?? null,
                sessionKey: scope.sessionKey,
              });
              const { replyPayloads } = await buildReplyPayloads({
                config: cfg,
                payloads: embedded,
                isHeartbeat: false,
                didLogHeartbeatStrip: false,
                blockStreamingEnabled: false,
                blockReplyPipeline: null,
                directBlockDeliveries,
                applyReplyToMode: createReplyToModeFilterForChannel("off", "telegram"),
                replyToMode: "off",
                replyToChannel: "telegram",
                currentMessageId: "456",
                normalizeMediaPaths: media.normalizePayload,
              });
              const persisted = await transcript.readLatestAssistantTextByIdentity(scope);
              expect(persisted?.text).toContain("MEDIA:" + sourcePath);
              expect(calls).toBe(2);
              expect(directBlockDeliveries.map((d) => d.outcome)).toEqual([
                "delivered",
                "cancelled",
              ]);
              expect(replyPayloads).toHaveLength(1);
              expect(replyPayloads[0]?.text).toBe(fullText);
              expect(replyPayloads[0]?.mediaUrls ?? []).toHaveLength(0);
              for (const payload of replyPayloads) {
                const sent = ledger.sendQueued("final", payload);
                expect(sent.queued).toBe(true);
                const outcome = await sent.outcome;
                finalOutcomes.push(outcome ?? "missing");
                expect(outcome).toBe("delivered");
              }
              return { queuedFinal: true, counts: dispatcher.getQueuedCounts() };
            } finally {
              await subscription.waitForPendingEvents();
              await Promise.allSettled(blockTasks);
              subscription.unsubscribe();
              typing.markRunComplete();
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
        expect(deliveryErrors).toEqual([]);
        expect(finalOutcomes).toEqual(["delivered"]);
        expect(receipts).toEqual([
          { phase: "cancelled-full-block", mediaCount: 1, usesOriginalPath: false },
          { phase: "shortened-final", mediaCount: 0, hadTarget: true, outputHasTarget: false },
        ]);
        const documents = native.filter((n) => n.method === "sendDocument");
        expect(documents).toHaveLength(1);
        expect(documents[0]?.files[0]?.content.toString("utf8")).toBe(
          "Synthetic prepared delivery note.\n",
        );
        const finalMessages = native.filter((n) => n.method === "sendMessage");
        expect(finalMessages.map((n) => n.fields.text)).toEqual([fullText]);
        expect(finalMessages.map(telegramReplyTarget)).toEqual([456]);
      } finally {
        disposeSession?.();
        await closeQaRuntimeStores(root);
        await fs.rm(root, { recursive: true, force: true });
        if (originalStateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = originalStateDir;
        }
      }
    });
  });
});

describeTelegramDispatch("accepted media source associations", () => {
  it.each(["partial reordered send", "hook substitution"] as const)(
    "preserves %s",
    async (scenario) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "media-source-selection-"));
      const workspace = path.join(root, "workspace");
      const originalStateDir = process.env.OPENCLAW_STATE_DIR;
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
      const sources = ["A", "B", "C"].map((name) => path.join(workspace, `${name}.txt`));
      const substitute = path.join(workspace, "D.txt");
      const acceptedEntries: Array<{ url: string; sourceUrls?: readonly string[] }> = [];
      try {
        await fs.mkdir(workspace, { recursive: true });
        for (const source of [...sources, substitute]) {
          await fs.writeFile(source, `Document ${path.basename(source, ".txt")}\n`);
        }
        const cfg = {
          agents: {
            defaults: { sandbox: { mode: "off" as const } },
            entries: { default: { workspace } },
          },
        };
        const media = createReplyMediaContext({
          cfg,
          agentId: "default",
          workspaceDir: workspace,
          sessionKey: "agent:default:telegram:direct:123",
          messageProvider: "telegram",
        });
        const normalized = await media.normalizePayload(
          await media.normalizePayload({ text: "Files.", mediaUrls: sources }),
        );
        const registry = createEmptyPluginRegistry();
        addTestHook({
          registry,
          pluginId: "media-source-selection",
          hookName: "reply_payload_sending",
          handler: (event: PluginHookReplyPayloadSendingEvent) => {
            const selected =
              scenario === "hook substitution"
                ? [substitute]
                : [
                    expectDefined(event.payload.mediaUrls?.[1], "Media B"),
                    expectDefined(event.payload.mediaUrls?.[0], "Media A"),
                  ];
            return {
              payload: {
                ...event.payload,
                mediaUrl: undefined,
                mediaUrls: selected,
                attachments: collectReplyMediaEntries(event.payload, selected).map(
                  ({ attachment }) => attachment ?? {},
                ),
              },
            };
          },
        });
        const selected = expectDefined(
          await runReplyPayloadSendingHook(
            {
              payload: normalized,
              kind: "block",
              channel: "telegram",
              context: { channelId: "telegram", conversationId: "123" },
            },
            createHookRunner(registry),
          ),
          "Hook-selected media",
        );
        await withTelegramReplyApi(
          async ({ bot, calls }) => {
            const sending = realTelegram.deliverStructuredReplies({
              bot,
              cfg,
              chatId: "123",
              token: "synthetic",
              replyToMode: "off",
              textLimit: 4000,
              runtime: {
                log: () => {},
                error: () => {},
                exit: () => {
                  throw new Error("exit");
                },
              },
              replies: [selected],
              mediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, "default"),
              onMediaAccepted: (urls) => {
                acceptedEntries.push(...collectReplyMediaEntries(selected, urls));
              },
            });
            if (scenario === "partial reordered send") {
              await expect(sending).rejects.toMatchObject({
                code: "CHANNEL_PARTIAL_DELIVERY",
                deliveryResult: { visibleReplySent: true, messageIds: ["1001"] },
              });
              expect(
                calls
                  .filter((call) => call.method === "sendDocument")
                  .map((call) => call.files[0]?.content.toString("utf8")),
              ).toEqual(["Document B\n", "Document A\n"]);
            } else {
              await expect(sending).resolves.toMatchObject({ delivered: true });
              expect(
                calls
                  .filter((call) => call.method === "sendDocument")
                  .map((call) => call.files[0]?.content.toString("utf8")),
              ).toEqual(["Document D\n"]);
            }
          },
          (call) =>
            call.files.some((file) => file.content.toString("utf8") === "Document A\n")
              ? { error_code: 400, description: "Bad Request: DOCUMENT_INVALID" }
              : undefined,
        );
        expect(acceptedEntries).toHaveLength(1);
        expect(acceptedEntries[0]?.sourceUrls).toEqual(
          scenario === "partial reordered send" ? [sources[1]] : undefined,
        );
        const accepted = new Set(
          acceptedEntries.flatMap((entry) => [entry.url].concat(entry.sourceUrls ?? [])),
        );
        const recovered = deduplicateBlockSentMedia(
          {
            text: "Recovered files.",
            mediaUrls: sources,
            attachments: sources.map((source) => ({ path: source, name: path.basename(source) })),
          },
          accepted,
        );
        const remaining =
          scenario === "partial reordered send"
            ? sources.filter((_, index) => index !== 1)
            : sources;
        expect(recovered?.mediaUrls).toEqual(remaining);
        expect(recovered?.attachments?.map((attachment) => attachment.name)).toEqual(
          remaining.map((source) => path.basename(source)),
        );
      } finally {
        await closeQaRuntimeStores(root);
        await fs.rm(root, { recursive: true, force: true });
        if (originalStateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = originalStateDir;
        }
      }
    },
  );
});

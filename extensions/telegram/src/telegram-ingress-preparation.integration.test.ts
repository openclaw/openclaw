// Real native admission/pipeline, grammY middleware and SQLite spool.
// Provider media and final dispatch are synthetic; no tenant state or live transport.
import { Api, Bot } from "grammy";
import type { Message } from "grammy/types";
import {
  createChannelIngressQueueForTests,
  closeOpenClawStateDatabaseForTest,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { resolveChannelGroupPolicy } from "openclaw/plugin-sdk/channel-policy";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import * as keyedAsyncQueue from "openclaw/plugin-sdk/keyed-async-queue";
import type { ChannelReplayClaimHandle } from "openclaw/plugin-sdk/persistent-dedupe";
import type { PluginHookBeforeChannelIngressContext } from "openclaw/plugin-sdk/plugin-entry";
import { registerVirtualTestPlugin } from "openclaw/plugin-sdk/plugin-test-contracts";
import { createHookRunner, createPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  createTelegramHandlerAuthorization,
  type TelegramHandlerAuthorization,
} from "./bot-handlers.inbound-authorization.js";
import {
  createTelegramInboundPipeline,
  registerTelegramInboundHandlers,
} from "./bot-handlers.inbound-pipeline.js";
import {
  createTelegramMessagePipeline,
  type TelegramMessagePipeline,
} from "./bot-handlers.message-pipeline.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { resolveTelegramPrimaryMedia } from "./bot/helpers.js";
import type { TelegramContext } from "./bot/types.js";
import { resolveTelegramScopedGroupConfig } from "./group-config-helpers.js";
import { createTelegramTransportIngressMonitor } from "./telegram-ingress-drain-factory.js";
import { openTelegramIngressQueue } from "./telegram-ingress-spool.js";
import { writeTelegramSpooledUpdate } from "./telegram-ingress-spool.test-support.js";

const hooks = vi.hoisted(() => ({
  prepare: vi.fn(),
  getRunner: vi.fn<() => ReturnType<typeof createHookRunner> | null>(() => null),
  downloads: vi.fn(),
  mediaResolution: vi.fn(),
  cancelled: vi.fn(),
  cfg: {
    commands: { allowFrom: { telegram: ["999999"] } },
    messages: { inbound: { debounceMs: 0 } },
    channels: {
      telegram: {
        dmPolicy: "allowlist" as const,
        allowFrom: ["111111"],
        groupPolicy: "allowlist" as const,
        groupAllowFrom: ["111111"],
        groups: {
          "-222": {
            allowFrom: ["111111"],
            topics: { "7": { enabled: false } },
          },
        },
      },
    },
  },
}));
vi.mock("./runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime.js")>();
  const { createPluginRuntimeMock: createRuntimeMock } =
    await import("openclaw/plugin-sdk/channel-test-helpers");
  const runtime = createRuntimeMock();
  return {
    ...actual,
    getTelegramRuntime: () => ({
      ...runtime,
      state: {
        ...runtime.state,
        openChannelIngressQueue: (
          options?: Omit<Parameters<typeof createChannelIngressQueueForTests>[0], "channelId">,
        ) => createChannelIngressQueueForTests({ ...options, channelId: "telegram" }),
      },
    }),
  };
});
vi.mock("openclaw/plugin-sdk/plugin-hook-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/plugin-hook-runtime")>()),
  getGlobalHookRunner: () => hooks.getRunner(),
}));
vi.mock("openclaw/plugin-sdk/runtime-config-snapshot", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-config-snapshot")>()),
  readRuntimeConfig: () => hooks.cfg,
}));
vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>()),
  readChannelAllowFromStore: async () => [],
}));
vi.mock("./telegram-ingress-drain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./telegram-ingress-drain.js")>();
  return {
    ...actual,
    createTelegramIngressMonitor: (
      params: Parameters<typeof actual.createTelegramIngressMonitor>[0],
    ) =>
      actual.createTelegramIngressMonitor({
        ...params,
        dispatch: (update, lifecycle) =>
          params.dispatch(update, {
            ...lifecycle,
            onCancelled: async () => {
              hooks.cancelled();
              await lifecycle.onCancelled();
            },
          }),
      }),
  };
});
// mock-isolation: Observe the media boundary without provider file downloads or transcription; all payloads and dispatch are synthetic.
vi.mock("./bot/delivery.resolve-media.js", () => ({
  resolveMedia: async ({ ctx }: { ctx: TelegramContext }) => {
    hooks.mediaResolution(ctx.message);
    const media = resolveTelegramPrimaryMedia(ctx.message);
    if (!media) {
      return null;
    }
    hooks.downloads(media.fileRef.file_id);
    await ctx.getFile();
    return {
      path: `/tmp/synthetic-${media.fileRef.file_id}`,
      contentType: media.kind === "audio" ? "audio/ogg" : "image/jpeg",
      kind: media.kind,
    };
  },
}));

const update = () => ({
  update_id: 42,
  message: {
    message_id: 21,
    date: 1_790_000_000,
    from: { id: 111111, is_bot: false, first_name: "Synthetic" },
    chat: { id: 111111, type: "private", first_name: "Synthetic" },
    voice: { file_id: "synthetic-file", file_unique_id: "synthetic-unique", duration: 1 },
  },
});

const groupUpdate = () => {
  const original = update();
  return {
    ...original,
    message: {
      ...original.message,
      chat: { id: -222, type: "supergroup" as const, title: "Synthetic group", is_forum: false },
    },
  };
};

function albumUpdates(secondCaption: string) {
  const original = groupUpdate();
  return ["ordinary first", secondCaption].map((caption, index) => ({
    update_id: original.update_id + index,
    message: {
      message_id: original.message.message_id + index,
      date: original.message.date,
      from: original.message.from,
      chat: original.message.chat,
      media_group_id: "synthetic-album",
      photo: [
        { file_id: `photo-${index}`, file_unique_id: `unique-${index}`, width: 1, height: 1 },
      ],
      caption,
      caption_entities:
        caption === "/reset@synthetic_bot"
          ? [{ type: "bot_command" as const, offset: 0, length: caption.length }]
          : [],
    },
  }));
}

async function withFixture(
  fn: (fixture: {
    queue: ReturnType<typeof openTelegramIngressQueue>;
    monitor: ReturnType<typeof createTelegramTransportIngressMonitor>;
    restart: () => ReturnType<typeof createTelegramTransportIngressMonitor>;
    seedUpdate: (nativeUpdate: unknown) => Promise<number>;
    waitForBufferedMedia: () => Promise<number>;
    downloads: ReturnType<typeof vi.fn>;
    bodies: string[];
    authorize: MockInstance<TelegramHandlerAuthorization["authorizeInboundMessage"]>;
    recorded: Message[];
    dedupe: MockInstance<TelegramMessagePipeline["claimMessageDispatchDedupe"]>;
    released: ChannelReplayClaimHandle[][];
    processed: Parameters<TelegramMessagePipeline["processMessageWithReplyChain"]>[0][];
    resolvedMedia: Parameters<TelegramMessagePipeline["recordMessageResolvedMedia"]>[0][];
    fileRequests: MockInstance<Bot["api"]["getFile"]>;
    replies: MockInstance<Bot["api"]["sendMessage"]>;
  }) => Promise<void>,
) {
  await withOpenClawTestState(
    { layout: "state-only", prefix: "openclaw-ingress-preparation-", applyEnv: true },
    async ({ stateDir }) => {
      const pluginId = "synthetic-ingress-preparer";
      const config = {
        ...hooks.cfg,
        plugins: { entries: { [pluginId]: { hooks: { allowConversationAccess: true } } } },
      };
      const builder = createPluginRegistry({
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        runtime: createPluginRuntimeMock(),
        activateGlobalSideEffects: false,
      });
      registerVirtualTestPlugin({
        registry: builder,
        config,
        id: pluginId,
        name: "Synthetic ingress preparer",
        register(api) {
          api.on("before_channel_ingress", (event, context) => hooks.prepare(event, context), {
            timeoutMs: 600_000,
          });
        },
      });
      expect(builder.registry.typedHooks).toHaveLength(1);
      expect(builder.registry.typedHooks[0]).toMatchObject({
        pluginId,
        hookName: "before_channel_ingress",
      });
      // Only runner lookup is injected. Registration, handler scoping and
      // fail-closed error propagation use their production implementations.
      hooks.getRunner.mockReturnValue(createHookRunner(builder.registry));
      const downloads = hooks.downloads;
      const bodies: string[] = [];
      const recorded: Message[] = [];
      const released: ChannelReplayClaimHandle[][] = [];
      const processed: Parameters<TelegramMessagePipeline["processMessageWithReplyChain"]>[0][] =
        [];
      const resolvedMedia: Parameters<TelegramMessagePipeline["recordMessageResolvedMedia"]>[0][] =
        [];
      const bot = new Bot("123:synthetic", {
        botInfo: {
          ...telegramBotInfoForTest,
          id: 222222,
          first_name: "Synthetic bot",
          username: "synthetic_bot",
        },
      });
      const fileRequests = vi
        .spyOn(Api.prototype, "getFile")
        .mockImplementation(async (fileId) => ({
          file_id: fileId,
          file_unique_id: `unique-${fileId}`,
          file_path: `${fileId}.bin`,
        }));
      const replies = vi
        .spyOn(Api.prototype, "sendMessage")
        .mockRejectedValue(new Error("unexpected synthetic Bot API reply"));
      const params = {
        nativeCommandNames: new Map([["status", "status"]]),
        accountId: "default",
        ownerAgentId: "main",
        bot,
        cfg: hooks.cfg,
        mediaMaxBytes: 1_000_000,
        opts: { token: "123:synthetic", botInfo: bot.botInfo },
        runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
        telegramCfg: hooks.cfg.channels.telegram,
        logger: { info: vi.fn(), warn: vi.fn() },
        resolveGroupPolicy: (chatId, cfg) =>
          resolveChannelGroupPolicy({
            cfg,
            channel: "telegram",
            accountId: "default",
            groupId: String(chatId),
          }),
        resolveGroupActivation: () => undefined,
        resolveGroupRequireMention: () => false,
        resolveTelegramGroupConfig: (chatId, topicId) =>
          resolveTelegramScopedGroupConfig(hooks.cfg.channels.telegram, chatId, topicId),
        shouldSkipUpdate: () => false,
        processMessage: async () => ({ kind: "completed" as const }),
      } satisfies RegisterTelegramHandlerParams;
      const message = createTelegramMessagePipeline(params);
      const dedupe = vi.spyOn(message, "claimMessageDispatchDedupe");
      const authorization = createTelegramHandlerAuthorization(params);
      // Spy only: the production implementation makes every allow/deny decision.
      const authorize = vi.spyOn(authorization, "authorizeInboundMessage");
      const pipeline = createTelegramInboundPipeline({
        params,
        authorization,
        message: {
          ...message,
          claimMessageDispatchDedupe: dedupe,
          releaseDispatchDedupeClaims: (claims, error) => {
            message.releaseDispatchDedupeClaims(claims, error);
            // Record only after the real owner has released each actual handle.
            released.push([...claims]);
          },
          resolveTelegramSessionState: async () => ({
            agentId: "main",
            bindingMode: { kind: "none" as const },
            sessionEntry: undefined,
            sessionKey: "synthetic",
            storePath: stateDir,
            model: undefined,
          }),
          resolvePromptContextAmbientWatermark: async () => undefined,
          recordMessageResolvedMedia: async (media) => {
            resolvedMedia.push(media);
          },
          recordMessageForReplyChain: async (msg) => {
            recorded.push(msg);
            return { messageId: String(msg.message_id), sender: "Synthetic", sourceMessage: msg };
          },
          processMessageWithReplyChain: async (processing) => {
            const { msg, dispatchDedupeClaims } = processing;
            // The synthetic processing boundary accepts this turn. Commit the
            // real claimed keys so fresh-update replays exercise native dedupe.
            for (const claim of dispatchDedupeClaims ?? []) {
              let diskError: unknown;
              await claim.commit({
                onDiskError: (error) => {
                  diskError = error;
                },
              });
              // Native dedupe permits a memory fallback. This fixture requires
              // the owned SQLite write to succeed before accepting the turn.
              if (diskError !== undefined) {
                throw diskError instanceof Error
                  ? diskError
                  : new Error("native dispatch dedupe persistence failed", { cause: diskError });
              }
            }
            processed.push(processing);
            bodies.push(msg.text ?? "unprepared audio");
            return { kind: "completed" as const };
          },
        },
      });
      const bufferedMedia = vi.spyOn(keyedAsyncQueue, "enqueueKeyedTask");
      const mediaTasks = () =>
        bufferedMedia.mock.results.flatMap((result, index) =>
          bufferedMedia.mock.calls[index]?.[0].key.startsWith("media:") && result.type === "return"
            ? [Promise.resolve(result.value)]
            : [],
        );
      registerTelegramInboundHandlers({ bot, pipeline });
      const restart = () =>
        createTelegramTransportIngressMonitor({
          stateDir,
          bot,
          accountId: "default",
          pollIntervalMs: 600_000,
        });
      const queue = openTelegramIngressQueue({ stateDir, accountId: "default" });
      const monitor = restart();
      try {
        await fn({
          queue,
          monitor,
          restart,
          seedUpdate: (nativeUpdate) =>
            writeTelegramSpooledUpdate({ stateDir, accountId: "default", update: nativeUpdate }),
          waitForBufferedMedia: async () => {
            const tasks = mediaTasks();
            await Promise.all(tasks);
            // Drain idle excludes deferred album custody; await its real settlement.
            await vi.waitFor(async () => {
              expect(await queue.listClaims()).toEqual([]);
              expect(await queue.listPending({ limit: "all" })).toEqual([]);
            });
            return tasks.length;
          },
          downloads,
          bodies,
          authorize,
          dedupe,
          recorded,
          released,
          processed,
          resolvedMedia,
          fileRequests,
          replies,
        });
        // Claim reads can also fall back to memory. Keep legitimate preparation
        // failure diagnostics, but never qualify a broken dedupe store as proof.
        expect(
          params.runtime.error.mock.calls.filter(([logMessage]) =>
            String(logMessage).includes("[telegram] message dispatch dedupe store failed:"),
          ),
        ).toEqual([]);
      } finally {
        // Buffered owners must finish before fixture state and spies are released.
        try {
          await Promise.all(mediaTasks());
        } finally {
          bufferedMedia.mockRestore();
          try {
            await monitor.stop();
          } finally {
            fileRequests.mockRestore();
            replies.mockRestore();
            try {
              await closeOpenClawStateDatabaseAsync();
            } finally {
              closeOpenClawStateDatabaseForTest();
            }
          }
        }
      }
    },
  );
}

describe("durable Telegram ingress preparation", () => {
  afterEach(() => {
    hooks.prepare.mockReset();
    hooks.getRunner.mockReset();
    hooks.downloads.mockReset();
    hooks.mediaResolution.mockReset();
    hooks.cancelled.mockReset();
    vi.useRealTimers();
  });

  it("rejects an unlisted native DM sender before preparation or private media I/O", async () => {
    hooks.prepare.mockResolvedValue({ text: "Must not run", suppressAttachments: true });
    await withFixture(async ({ monitor, authorize, downloads, bodies, dedupe }) => {
      const denied = update();
      denied.message.from.id = 999999;
      denied.message.chat.id = 999999;
      monitor.start();
      await monitor.admit(denied);
      await monitor.waitForIdle();
      expect(authorize).toHaveBeenCalledOnce();
      await expect(authorize.mock.results[0]?.value).resolves.toEqual({ allowed: false });
      expect(dedupe).not.toHaveBeenCalled();
      expect(hooks.prepare).not.toHaveBeenCalled();
      expect(downloads).not.toHaveBeenCalled();
      expect(bodies).toEqual([]);
    });
  });

  it("rejects a native-denied control command before registered preparation or private I/O", async () => {
    hooks.prepare.mockResolvedValue({ text: "Must not run", suppressAttachments: true });
    await withFixture(async ({ monitor, authorize, downloads, bodies, dedupe, recorded }) => {
      const original = update();
      const command = {
        update_id: original.update_id,
        message: {
          message_id: original.message.message_id,
          date: original.message.date,
          from: { ...original.message.from, id: 666666 },
          chat: { ...original.message.chat, id: 666666 },
          text: "/status",
          entities: [{ type: "bot_command", offset: 0, length: 7 }],
        },
      };
      monitor.start();
      await monitor.admit(command);
      await monitor.waitForIdle();
      expect(authorize).toHaveBeenCalledOnce();
      await expect(authorize.mock.results[0]?.value).resolves.toEqual({ allowed: false });
      expect(dedupe).not.toHaveBeenCalled();
      expect(hooks.prepare).not.toHaveBeenCalled();
      expect(downloads).not.toHaveBeenCalled();
      expect(recorded).toEqual([]);
      expect(bodies).toEqual([]);
    });
  });

  it.each(["/reset", "/config show"])(
    "rejects command-denied DM media before preparation or private I/O (%s)",
    async (caption) => {
      await withFixture(async ({ monitor, authorize, dedupe, fileRequests, processed }) => {
        const original = update();
        monitor.start();
        await monitor.admit({ ...original, message: { ...original.message, caption } });
        await monitor.waitForIdle();
        await expect(authorize.mock.results[0]?.value).resolves.toEqual({ allowed: false });
        expect(dedupe).not.toHaveBeenCalled();
        expect(hooks.prepare).not.toHaveBeenCalled();
        expect(hooks.mediaResolution).not.toHaveBeenCalled();
        expect(fileRequests).not.toHaveBeenCalled();
        expect(processed).toEqual([]);
      });
    },
  );

  it("rejects command-denied media from an admitted group sender before registered preparation", async () => {
    const getFile = vi.fn();
    const transcribe = vi.fn();
    hooks.prepare.mockImplementation(async () => {
      getFile();
      transcribe();
      return { text: "Must not hide the command", suppressAttachments: true };
    });
    await withFixture(
      async ({ queue, monitor, authorize, fileRequests, replies, processed, recorded }) => {
        const original = groupUpdate();
        const denied = { ...original, message: { ...original.message, caption: "/reset" } };
        monitor.start();
        await monitor.admit(denied);
        await monitor.waitForIdle();
        expect(authorize).toHaveBeenCalledOnce();
        await expect(authorize.mock.results[0]?.value).resolves.toMatchObject({
          allowed: true,
          context: { commandAuthorizedByConfig: false },
        });
        expect(hooks.prepare).not.toHaveBeenCalled();
        expect(getFile).not.toHaveBeenCalled();
        expect(transcribe).not.toHaveBeenCalled();
        expect(hooks.mediaResolution).not.toHaveBeenCalled();
        expect(fileRequests).not.toHaveBeenCalled();
        expect(replies).not.toHaveBeenCalled();
        expect(processed).toEqual([]);
        expect(recorded).toEqual([denied.message]);
        expect(await queue.listClaims()).toEqual([]);
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
      },
    );
  });

  it("prepares ordinary media from the same admitted group sender", async () => {
    hooks.prepare.mockResolvedValue({ text: "Prepared group voice", suppressAttachments: true });
    await withFixture(async ({ monitor, authorize, bodies, fileRequests }) => {
      monitor.start();
      await monitor.admit(groupUpdate());
      await monitor.waitForIdle();
      await expect(authorize.mock.results[0]?.value).resolves.toMatchObject({
        allowed: true,
        context: { commandAuthorizedByConfig: false },
      });
      expect(hooks.prepare).toHaveBeenCalledOnce();
      expect(fileRequests).not.toHaveBeenCalled();
      expect(bodies).toEqual(["Prepared group voice"]);
    });
  });

  it.each([
    ["message", "/reset"],
    ["message", "/config show"],
    ["message", "[Tue 2026-06-02 12:34] /reset"],
    ["edited_message", "/reset"],
    ["edited_message", "/config show"],
    ["edited_message", "[Tue 2026-06-02 12:34] /reset"],
  ] as const)(
    "delegates an original %s control command without preparation (%s)",
    async (kind, text) => {
      hooks.prepare.mockResolvedValue({
        text: "Must not rewrite a native command",
        suppressAttachments: true,
      });
      await withFixture(async ({ monitor, authorize, recorded, fileRequests, processed }) => {
        const original = groupUpdate();
        const commandName = text.match(/\/\S+/)?.[0] ?? "";
        const command = {
          message_id: original.message.message_id,
          date: original.message.date,
          from: original.message.from,
          chat: original.message.chat,
          text,
          entities: [
            { type: "bot_command" as const, offset: text.indexOf("/"), length: commandName.length },
          ],
        };
        monitor.start();
        await monitor.admit({ update_id: original.update_id, [kind]: command });
        await monitor.waitForIdle();
        await expect(authorize.mock.results[0]?.value).resolves.toMatchObject({
          allowed: true,
          context: { commandAuthorizedByConfig: false },
        });
        expect(hooks.prepare).not.toHaveBeenCalled();
        expect(recorded).toEqual([command]);
        expect(fileRequests).not.toHaveBeenCalled();
        expect(hooks.downloads).not.toHaveBeenCalled();
        // Final command dispatch is synthetic here. Prove unchanged delegation,
        // not a command-delivery denial owned by the production context builder.
        expect(processed.map((processing) => processing.msg)).toEqual(
          kind === "message" ? [command] : [],
        );
      });
    },
  );

  it("retains album-wide command rejection before preparation or any provider media I/O", async () => {
    const getFile = vi.fn();
    const transcribe = vi.fn();
    hooks.prepare.mockImplementation(async () => {
      getFile();
      transcribe();
      return { text: "Must not hide the album command", suppressAttachments: true };
    });
    await withFixture(
      async ({
        queue,
        monitor,
        seedUpdate,
        waitForBufferedMedia,
        authorize,
        fileRequests,
        replies,
        processed,
        recorded,
      }) => {
        const originals = albumUpdates("/reset@synthetic_bot");
        for (const original of originals) {
          await seedUpdate(original);
        }
        monitor.start();
        await monitor.waitForIdle();
        const mediaOwners = await waitForBufferedMedia();
        expect(authorize).toHaveBeenCalledTimes(2);
        for (const result of authorize.mock.results) {
          await expect(result.value).resolves.toMatchObject({
            allowed: true,
            context: { commandAuthorizedByConfig: false },
          });
        }
        expect(hooks.prepare).not.toHaveBeenCalled();
        expect(mediaOwners).toBe(1);
        expect(getFile).not.toHaveBeenCalled();
        expect(transcribe).not.toHaveBeenCalled();
        expect(hooks.mediaResolution).not.toHaveBeenCalled();
        expect(fileRequests).not.toHaveBeenCalled();
        expect(replies).not.toHaveBeenCalled();
        expect(processed).toEqual([]);
        expect(recorded).toEqual(originals.map((original) => original.message));
        expect(await queue.listClaims()).toEqual([]);
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
      },
    );
  });

  it("keeps permitted albums on native collection and delivery without preparation", async () => {
    hooks.prepare.mockResolvedValue({
      text: "Must not split the album",
      suppressAttachments: true,
    });
    await withFixture(
      async ({
        queue,
        monitor,
        seedUpdate,
        waitForBufferedMedia,
        fileRequests,
        replies,
        processed,
        resolvedMedia,
      }) => {
        const originals = albumUpdates("ordinary second");
        for (const original of originals) {
          await seedUpdate(original);
        }
        monitor.start();
        await monitor.waitForIdle();
        const mediaOwners = await waitForBufferedMedia();
        expect(hooks.prepare).not.toHaveBeenCalled();
        expect(mediaOwners).toBe(1);
        expect(hooks.mediaResolution).toHaveBeenCalledTimes(2);
        expect(fileRequests.mock.calls.map(([fileId]) => fileId)).toEqual(["photo-0", "photo-1"]);
        expect(resolvedMedia).toHaveLength(2);
        expect(processed).toHaveLength(1);
        expect(processed[0]?.msg.caption).toBe(`ordinary first
ordinary second`);
        expect(processed[0]?.allMedia.map((media) => media.sourceMessageId)).toEqual(["21", "22"]);
        expect(replies).not.toHaveBeenCalled();
        expect(await queue.listClaims()).toEqual([]);
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
      },
    );
  });

  it("keeps an admitted command-denied edit in the native cache without preparation", async () => {
    hooks.prepare.mockResolvedValue({
      text: "Must not replace the command",
      suppressAttachments: true,
    });
    await withFixture(async ({ monitor, authorize, recorded, fileRequests, processed }) => {
      const original = groupUpdate();
      const edited = { ...original.message, caption: "/reset" };
      monitor.start();
      await monitor.admit({ update_id: original.update_id, edited_message: edited });
      await monitor.waitForIdle();
      await expect(authorize.mock.results[0]?.value).resolves.toMatchObject({
        allowed: true,
        context: { commandAuthorizedByConfig: false },
      });
      expect(hooks.prepare).not.toHaveBeenCalled();
      expect(recorded).toEqual([edited]);
      expect(hooks.mediaResolution).not.toHaveBeenCalled();
      expect(fileRequests).not.toHaveBeenCalled();
      expect(processed).toEqual([]);
    });
  });

  it("keeps album edits unchanged in the native cache without preparation", async () => {
    hooks.prepare.mockResolvedValue({
      text: "Must not replace the album",
      suppressAttachments: true,
    });
    await withFixture(async ({ monitor, recorded, fileRequests, processed }) => {
      const original = albumUpdates("ordinary second")[0];
      if (!original) {
        throw new Error("expected an original album member");
      }
      monitor.start();
      await monitor.admit({ update_id: original.update_id, edited_message: original.message });
      await monitor.waitForIdle();
      expect(hooks.prepare).not.toHaveBeenCalled();
      expect(recorded).toEqual([original.message]);
      expect(hooks.mediaResolution).not.toHaveBeenCalled();
      expect(fileRequests).not.toHaveBeenCalled();
      expect(processed).toEqual([]);
    });
  });

  it("rejects an allowlisted sender in a disabled native forum topic before preparation", async () => {
    hooks.prepare.mockResolvedValue({ text: "Must not run", suppressAttachments: true });
    await withFixture(async ({ monitor, authorize, downloads, bodies, dedupe }) => {
      const original = update();
      const denied = {
        ...original,
        message: {
          ...original.message,
          chat: { id: -222, type: "supergroup", title: "Synthetic forum", is_forum: true },
          message_thread_id: 7,
        },
      };
      monitor.start();
      await monitor.admit(denied);
      await monitor.waitForIdle();
      expect(authorize).toHaveBeenCalledOnce();
      await expect(authorize.mock.results[0]?.value).resolves.toEqual({ allowed: false });
      expect(dedupe).not.toHaveBeenCalled();
      expect(hooks.prepare).not.toHaveBeenCalled();
      expect(downloads).not.toHaveBeenCalled();
      expect(bodies).toEqual([]);
    });
  });

  it("prepares an authorized native message once and dispatches its prepared text", async () => {
    hooks.prepare.mockResolvedValue({
      text: "Authorized prepared text",
      suppressAttachments: true,
    });
    await withFixture(async ({ monitor, authorize, downloads, bodies }) => {
      monitor.start();
      await monitor.admit(update());
      await monitor.waitForIdle();
      await monitor.admit(update());
      await monitor.waitForIdle();
      expect(authorize).toHaveBeenCalledOnce();
      expect(hooks.prepare).toHaveBeenCalledOnce();
      expect(downloads).not.toHaveBeenCalled();
      expect(bodies).toEqual(["Authorized prepared text"]);
    });
  });

  it("preserves a command-only config grant without preparing or rewriting its text", async () => {
    hooks.prepare.mockResolvedValue({
      text: "Must not replace a command grant",
      suppressAttachments: true,
    });
    await withFixture(async ({ monitor, authorize, downloads, bodies, recorded }) => {
      const original = update();
      const command = {
        ...original,
        message: {
          message_id: original.message.message_id,
          date: original.message.date,
          from: { ...original.message.from, id: 999999 },
          chat: { ...original.message.chat, id: 999999 },
          text: "/status",
          entities: [{ type: "bot_command", offset: 0, length: 7 }],
        },
      };
      monitor.start();
      await monitor.admit(command);
      await monitor.waitForIdle();
      expect(authorize).toHaveBeenCalledOnce();
      const gate = await authorize.mock.results[0]?.value;
      if (!gate?.allowed) {
        throw new Error("expected native command config grant");
      }
      expect(gate.context.commandAuthorizedByConfig).toBe(true);
      expect(hooks.prepare).not.toHaveBeenCalled();
      expect(downloads).not.toHaveBeenCalled();
      expect(bodies).toEqual(["/status"]);
      expect(recorded[0]).toMatchObject({ text: "/status", entities: command.message.entities });
    });
  });

  it("does not prepare a native dispatch duplicate carried by a fresh transport update", async () => {
    hooks.prepare.mockResolvedValue({ text: "Prepared once", suppressAttachments: true });
    await withFixture(async ({ monitor, authorize, downloads, bodies, dedupe }) => {
      monitor.start();
      await monitor.admit(update());
      await monitor.waitForIdle();
      await monitor.admit({ ...update(), update_id: 43 });
      await monitor.waitForIdle();
      expect(authorize).toHaveBeenCalledTimes(2);
      expect(dedupe).toHaveBeenCalledTimes(2);
      await expect(dedupe.mock.results[1]?.value).resolves.toEqual({ process: false });
      expect(hooks.prepare).toHaveBeenCalledOnce();
      expect(downloads).not.toHaveBeenCalled();
      expect(bodies).toEqual(["Prepared once"]);
    });
  });

  it("retains silent native admission for unauthorized edits", async () => {
    hooks.prepare.mockResolvedValue({ text: "Must not run", suppressAttachments: true });
    await withFixture(async ({ monitor, authorize, downloads, bodies }) => {
      const original = update();
      original.message.from.id = 999999;
      original.message.chat.id = 999999;
      monitor.start();
      await monitor.admit({ update_id: original.update_id, edited_message: original.message });
      await monitor.waitForIdle();
      expect(authorize).toHaveBeenCalledOnce();
      expect(authorize.mock.calls[0]?.[0].dmAccess).toBe("silent");
      await expect(authorize.mock.results[0]?.value).resolves.toEqual({ allowed: false });
      expect(hooks.prepare).not.toHaveBeenCalled();
      expect(downloads).not.toHaveBeenCalled();
      expect(bodies).toEqual([]);
    });
  });

  it("prepares an authorized edit only for the native reply cache", async () => {
    hooks.prepare.mockResolvedValue({ text: "Authorized edited text", suppressAttachments: true });
    await withFixture(async ({ monitor, authorize, downloads, bodies, recorded }) => {
      const original = update();
      monitor.start();
      await monitor.admit({ update_id: original.update_id, edited_message: original.message });
      await monitor.waitForIdle();
      expect(authorize).toHaveBeenCalledOnce();
      expect(authorize.mock.calls[0]?.[0].dmAccess).toBe("silent");
      expect(hooks.prepare).toHaveBeenCalledOnce();
      expect(recorded).toMatchObject([
        { text: "Authorized edited text", from: original.message.from },
      ]);
      expect(recorded[0]).not.toHaveProperty("voice");
      expect(downloads).not.toHaveBeenCalled();
      expect(bodies).toEqual([]);
    });
  });

  it("keeps an actual preparation claim alive beyond the native five-minute watchdog without early adoption", async () => {
    vi.useFakeTimers();
    const started = createDeferred();
    const terminal = createDeferred();
    let stopHeartbeat: (() => void) | undefined;
    hooks.prepare.mockImplementation(async (_event, rawContext) => {
      const context = rawContext as PluginHookBeforeChannelIngressContext;
      const timer = setInterval(context.heartbeat, context.heartbeatIntervalMs);
      stopHeartbeat = () => clearInterval(timer);
      started.resolve();
      try {
        await terminal.promise;
        return { text: "Verified transcript", suppressAttachments: true };
      } finally {
        clearInterval(timer);
      }
    });
    await withFixture(async ({ queue, monitor, downloads, bodies }) => {
      monitor.start();
      await monitor.admit(update());
      await Promise.race([
        started.promise,
        monitor.waitForIdle().then(() => {
          throw new Error("preparation hook was not invoked before native dispatch");
        }),
      ]);
      try {
        await vi.advanceTimersByTimeAsync(360_000);
        expect(downloads).not.toHaveBeenCalled();
        expect((await queue.listClaims()).map((row) => row.id)).toEqual(["0000000000000042"]);
        terminal.resolve();
        await monitor.waitForIdle();
        expect(bodies).toEqual(["Verified transcript"]);
        expect(downloads).not.toHaveBeenCalled();
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        await monitor.admit(update());
        await monitor.waitForIdle();
        expect(bodies).toHaveLength(1);
      } finally {
        stopHeartbeat?.();
        terminal.resolve();
      }
    });
  });

  it("preserves retry facts when native stop cancels preparation, then resumes once without backoff", async () => {
    const started = createDeferred();
    hooks.prepare.mockImplementation((_event, rawContext) => {
      const context = rawContext as PluginHookBeforeChannelIngressContext;
      started.resolve();
      return new Promise((_resolve, reject) => {
        context.abortSignal.addEventListener(
          "abort",
          () => {
            const reason = context.abortSignal.reason;
            reject(
              reason instanceof Error
                ? reason
                : new Error("preparation aborted", { cause: reason }),
            );
          },
          { once: true },
        );
      });
    });
    await withFixture(async ({ queue, monitor, restart, downloads, bodies, dedupe, released }) => {
      monitor.start();
      await monitor.admit(update());
      await started.promise;
      expect((await queue.listClaims())[0]?.attempts).toBe(0);
      const claimed = await dedupe.mock.results[0]?.value;
      expect(claimed?.process).toBe(true);
      if (!claimed?.process) {
        throw new Error("expected a native dispatch claim");
      }
      expect(claimed.claims).toHaveLength(1);
      expect(claimed.claims[0]?.keys.length).toBeGreaterThan(0);
      hooks.cancelled.mockImplementation(() => {
        // This callback runs before the durable owner reopens the spool row.
        // Its claim must already be released by the actual pipeline catch.
        expect(released).toHaveLength(1);
        expect(released[0]).toEqual(claimed.claims);
      });
      await monitor.stop();
      expect(hooks.cancelled).toHaveBeenCalledOnce();
      const pending = await queue.listPending({ limit: "all" });
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ attempts: 0, payload: { update: update() } });
      expect(pending[0]?.lastAttemptAt).toBeUndefined();
      expect(pending[0]?.lastError).toBeUndefined();
      expect(downloads).not.toHaveBeenCalled();
      expect(bodies).toEqual([]);
      hooks.prepare.mockResolvedValue({ text: "Resumed transcript", suppressAttachments: true });
      const resumed = restart();
      try {
        resumed.start();
        await resumed.waitForIdle();
        expect(bodies).toEqual(["Resumed transcript"]);
        expect(await queue.listPending({ limit: "all" })).toEqual([]);
        await resumed.admit(update());
        await resumed.waitForIdle();
        expect(bodies).toHaveLength(1);
      } finally {
        await resumed.stop();
      }
    });
  });

  it("retains the original queued update when the registered preparer rejects consent revoked during await", async () => {
    const started = createDeferred();
    const continuePreparation = createDeferred();
    const consent = { allowed: true };
    const getFile = vi.fn();
    const transcribe = vi.fn();
    hooks.prepare.mockImplementation(async () => {
      if (!consent.allowed) {
        throw new Error("synthetic preparation consent revoked");
      }
      started.resolve();
      await continuePreparation.promise;
      // This preparer owns its consent and rechecks it before private I/O.
      // The generic hook runner has no consent store or revocation detector.
      if (!consent.allowed) {
        throw new Error("synthetic preparation consent revoked");
      }
      getFile();
      transcribe();
      return { text: "Must not be adopted", suppressAttachments: true };
    });
    await withFixture(
      async ({ queue, monitor, authorize, downloads, bodies, recorded, dedupe, released }) => {
        const original = update();
        monitor.start();
        await monitor.admit(original);
        await started.promise;
        expect(authorize).toHaveBeenCalledOnce();
        const gate = await authorize.mock.results[0]?.value;
        expect(gate?.allowed).toBe(true);
        const claimed = await dedupe.mock.results[0]?.value;
        if (!claimed?.process) {
          throw new Error("expected a native dispatch claim");
        }
        expect(claimed.claims).toHaveLength(1);
        expect(claimed.claims[0]?.keys.length).toBeGreaterThan(0);
        expect(await queue.listClaims()).toHaveLength(1);

        consent.allowed = false;
        continuePreparation.resolve();
        // Observe rejection settlement while the owner is still running.
        // Stopping the monitor would exercise a different cancellation boundary.
        await monitor.waitForIdle();
        expect(hooks.prepare).toHaveBeenCalledOnce();
        expect(hooks.cancelled).not.toHaveBeenCalled();
        expect(getFile).not.toHaveBeenCalled();
        expect(transcribe).not.toHaveBeenCalled();
        expect(downloads).not.toHaveBeenCalled();
        expect(recorded).toEqual([]);
        expect(bodies).toEqual([]);
        expect(released).toEqual([claimed.claims]);
        expect(await queue.listClaims()).toEqual([]);
        const pending = await queue.listPending({ limit: "all" });
        expect(pending).toHaveLength(1);
        expect(pending[0]?.payload.update).toEqual(original);
        expect(pending[0]?.attempts).toBe(1);
        expect(pending[0]?.lastError).toContain("synthetic preparation consent revoked");
      },
    );
  });

  it("retains original attachment identity across failed preparation and restart, then dispatches once", async () => {
    hooks.prepare.mockRejectedValue(new Error("transcript not ready"));
    await withFixture(async ({ queue, monitor, restart, downloads, bodies }) => {
      monitor.start();
      await monitor.admit(update());
      await monitor.waitForIdle();
      expect(downloads).not.toHaveBeenCalled();
      const pending = await queue.listPending({ limit: "all" });
      expect(pending).toHaveLength(1);
      expect(pending[0]?.payload.update).toMatchObject({
        update_id: 42,
        message: {
          message_id: 21,
          from: { id: 111111 },
          voice: { file_id: "synthetic-file" },
        },
      });
      await monitor.stop();
      hooks.prepare.mockResolvedValue({ text: "Recovered transcript", suppressAttachments: true });
      vi.useFakeTimers();
      await vi.advanceTimersByTimeAsync(60_000);
      const recovered = restart();
      try {
        recovered.start();
        await recovered.waitForIdle();
        expect(bodies).toEqual(["Recovered transcript"]);
        expect(downloads).not.toHaveBeenCalled();
        await recovered.admit(update());
        await recovered.waitForIdle();
        expect(bodies).toHaveLength(1);
      } finally {
        await recovered.stop();
      }
    });
  });
});

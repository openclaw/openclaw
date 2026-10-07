import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type * as AgentRuntime from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { PLUGIN_COMMAND_DISPATCH } from "openclaw/plugin-sdk/plugin-command-runtime";
import type {
  OpenClawPluginCommandDefinition,
  PluginCommandResult,
} from "openclaw/plugin-sdk/plugin-entry";
import { matchPluginCommand, registerPluginCommand } from "openclaw/plugin-sdk/plugin-runtime";
import {
  addTestHook,
  createEmptyPluginRegistry,
  getActivePluginRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  parseSqliteSessionFileMarker,
  resolveStorePath,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  appendSessionTranscriptMessageByIdentity,
  readLatestAssistantTextByIdentity,
  readVisibleSessionTranscriptMessageEntries,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiCalls,
  chat,
  commandMessage,
  createBot,
  from,
  groupChat,
  groupCommand,
  harness,
  photo,
} from "./bot.create-telegram-bot.native-pipeline.test-support.js";
import { resetTelegramClientOptionsCacheForTests } from "./send.js";

const { loadPreparedModelCatalog } = vi.hoisted(() => ({
  loadPreparedModelCatalog: vi.fn<typeof AgentRuntime.loadPreparedModelCatalog>(),
}));
vi.mock("openclaw/plugin-sdk/agent-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof AgentRuntime>()),
  loadPreparedModelCatalog,
}));

function commandConfig(overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return {
    commands: { native: true },
    session: { store: join(process.env.OPENCLAW_STATE_DIR!, `${randomUUID()}.json`) },
    channels: {
      telegram: {
        botToken: "123:test-token",
        dmPolicy: "open",
        allowFrom: ["*"],
        streaming: { mode: "off" },
      },
    },
    ...overrides,
  };
}

type MenuPayload = {
  text: string;
  reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
};

function sentMenu(): MenuPayload {
  const call = apiCalls.mock.calls.find(([method]) => method === "sendMessage");
  if (!call) {
    throw new Error("No command response reached the Bot API");
  }
  return call[1] as MenuPayload;
}

beforeEach(() => {
  loadPreparedModelCatalog.mockReset().mockImplementation(async (params) => {
    if (!params?.readOnly) {
      throw new Error("native menus must not start full model discovery");
    }
    return [
      {
        provider: "native-test",
        id: "reasoner",
        name: "Prepared reasoner",
        reasoning: true,
        compat: { supportedReasoningEfforts: ["max"] },
      },
      { provider: "native-test", id: "plain", name: "Plain", reasoning: false },
    ];
  });
});

describe("Telegram typed command delivery", () => {
  it("replies to the selected photo quote for a native command", async () => {
    harness.replySpy.mockResolvedValue({ text: "Checked the photo.", replyToId: "30101" });
    const bot = await createBot(true, true, {
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          streaming: { mode: "off" },
          replyToMode: "first",
        },
      },
    });
    await bot.handleUpdate({
      update_id: 3001,
      message: {
        ...commandMessage("/btw check this pls"),
        message_id: 30101,
        reply_to_message: {
          message_id: 100,
          date: 1736380790,
          chat,
          from,
          photo,
          caption: "Photo to check",
          reply_to_message: undefined,
        },
        quote: { text: "Photo to check", position: 0 },
      },
    });
    expect(harness.replySpy).toHaveBeenCalledTimes(1);
    expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({
      CommandSource: "native",
      CommandTurn: { kind: "native", body: "/btw check this pls" },
      ReplyToBody: expect.stringContaining("Photo to check"),
      media: expect.arrayContaining([expect.objectContaining({ path: "/tmp/replied-photo.jpg" })]),
    });
    expect(apiCalls).toHaveBeenCalledWith(
      "sendMessage",
      expect.objectContaining({
        chat_id: String(chat.id),
        text: "Checked the photo.",
        reply_parameters: expect.objectContaining({ message_id: 100, quote: "Photo to check" }),
      }),
    );
  });

  it("records a quoted command once when native quoting requires fallback delivery", async () => {
    const cfg = commandConfig();
    cfg.channels!.telegram!.replyToMode = "first";
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:main",
      sessionId: "quoted-command",
      storePath: cfg.session!.store!,
    };
    await upsertSessionEntry({
      ...scope,
      entry: { sessionId: scope.sessionId, updatedAt: 1 },
    });
    await appendSessionTranscriptMessageByIdentity({
      ...scope,
      message: { role: "assistant", content: "Earlier answer", timestamp: 1 },
    });
    harness.replySpy.mockResolvedValue({ text: "Thinking level set to low.", replyToId: "30102" });
    const bot = await createBot(true, true, cfg);
    await bot.handleUpdate({
      update_id: 3002,
      message: {
        ...commandMessage("/think low"),
        message_id: 30102,
        reply_to_message: {
          message_id: 100,
          date: 1736380790,
          chat,
          from,
          text: "Earlier answer",
          reply_to_message: undefined,
        },
        quote: { text: "Earlier answer", position: 0 },
      },
    });
    expect(apiCalls).toHaveBeenCalledWith(
      "sendMessage",
      expect.objectContaining({
        text: "Thinking level set to low.",
        reply_parameters: expect.objectContaining({ message_id: 100, quote: "Earlier answer" }),
      }),
    );
    const messages = (await readVisibleSessionTranscriptMessageEntries(scope)).map(
      ({ message }) => message,
    );
    expect(messages).toMatchObject([
      { role: "assistant", content: "Earlier answer" },
      { role: "user", content: [{ type: "text", text: "/think low" }] },
      { role: "assistant", content: [{ type: "text", text: "Thinking level set to low." }] },
    ]);
  });

  it("preserves the builtin catalog choice when a plugin registers fast", async () => {
    const previousRegistry = getActivePluginRegistry();
    try {
      expect(
        registerPluginCommand("fast-controls", {
          name: "fast",
          description: "Fast controls",
          acceptsArgs: true,
          handler: async () => ({ text: "Plugin fast reply" }),
        }),
      ).toEqual({ ok: true });
      expect(matchPluginCommand("/fast on", { channel: "telegram" })).toMatchObject({
        command: { name: "fast", pluginId: "fast-controls" },
        args: "on",
      });
      const bot = await createBot();
      await bot.handleUpdate({ update_id: 3004, message: commandMessage("/fast on") });
      expect(harness.replySpy).toHaveBeenCalledOnce();
      expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({
        CommandSource: "native",
        CommandTurn: { kind: "native", body: "/fast on" },
      });
      expect(harness.replySpy.mock.calls[0]?.[1]).toMatchObject({
        [PLUGIN_COMMAND_DISPATCH]: { kind: "non-plugin" },
      });
    } finally {
      if (previousRegistry) {
        setActivePluginRegistry(previousRegistry);
      } else {
        resetPluginRuntimeStateForTest();
      }
    }
  });
});

describe("Telegram native argument menus", () => {
  it("records native menus in the configured store despite a stale default binding", async () => {
    const cfg = commandConfig();
    const sessionKey = "agent:main:main";
    await upsertSessionEntry({
      agentId: "main",
      storePath: resolveStorePath(undefined, { agentId: "main" }),
      sessionKey,
      entry: { sessionId: "stale-default", updatedAt: 1 },
    });
    await upsertSessionEntry({
      agentId: "main",
      storePath: cfg.session!.store!,
      sessionKey,
      entry: { sessionId: "configured-native", updatedAt: 1 },
    });
    const bot = await createBot(true, true, cfg, true);
    await bot.handleUpdate({ update_id: 3100, message: commandMessage("/think") });
    const latest = await readLatestAssistantTextByIdentity({
      agentId: "main",
      sessionKey,
      sessionId: "configured-native",
      storePath: cfg.session!.store!,
    });
    expect(latest?.text).toContain(sentMenu().text);
  });

  it.each(["unpinned", "explicit parent", "off"] as const)(
    "uses the %s model settings for a DM-topic keyboard",
    async (thinking) => {
      const pinned = thinking !== "off";
      const cfg = commandConfig(
        pinned
          ? {
              agents: {
                defaults: {
                  model: "native-test/plain",
                  thinkingDefault: "low",
                  models: { "native-test/reasoner": {} },
                },
              },
            }
          : {
              agents: {
                ownership: "explicit",
                defaults: {
                  model: "native-test/reasoner",
                  thinkingDefault: "medium",
                  models: { "native-test/reasoner": { params: { thinking: "low" } } },
                },
                entries: {
                  main: {},
                  alpha: { models: { "native-test/reasoner": { params: { thinking } } } },
                },
              },
              bindings: [
                { agentId: "alpha", match: { channel: "telegram", accountId: "default" } },
              ],
            },
      );
      const pinnedSessionKey =
        thinking === "explicit parent" ? "agent:main:spawner" : "agent:main:main";
      if (pinned) {
        await upsertSessionEntry({
          storePath: cfg.session!.store!,
          sessionKey: pinnedSessionKey,
          entry: {
            sessionId: "parent",
            updatedAt: 1,
            providerOverride: "native-test",
            modelOverride: "reasoner",
            modelOverrideSource: "user",
          },
        });
      }
      if (thinking === "explicit parent") {
        await upsertSessionEntry({
          storePath: cfg.session!.store!,
          sessionKey: "agent:main:main:thread:42001:77",
          entry: { sessionId: "forked-topic", updatedAt: 1, parentSessionKey: pinnedSessionKey },
        });
      }
      await (
        await createBot(true, true, cfg, true)
      ).handleUpdate({
        update_id: 3101,
        message: { ...commandMessage("/think"), message_thread_id: 77 },
      });
      const choices = sentMenu().reply_markup.inline_keyboard.flat();
      if (thinking === "off") {
        expect(sentMenu().text).toContain(`Current thinking level: ${thinking}.\n`);
      } else if (thinking === "explicit parent") {
        expect(choices).toContainEqual({ text: "max", callback_data: "tgcmd:/think max" });
      } else {
        expect(choices.map((choice) => choice.text)).toEqual(["default", "off", "ultra"]);
      }
      expect(apiCalls).toHaveBeenCalledWith(
        "sendMessage",
        expect.objectContaining({ message_thread_id: 77 }),
      );
    },
  );
});

describe("Telegram registered plugin delivery", () => {
  type ApiRequest = { method: string; payload: Record<string, unknown> };
  const requests: ApiRequest[] = [];
  let apiRoot: string;
  let nextMessageId = 700;
  let rejectEdit = false;
  let previousRegistry = getActivePluginRegistry();
  let registry = createEmptyPluginRegistry();
  let server: Server;
  const mediaDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeAll(async () => {
    server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks);
        const contentType = request.headers["content-type"] ?? "";
        const payload: Record<string, unknown> = contentType.includes("multipart/form-data")
          ? Object.fromEntries(
              await new Request("http://localhost", {
                method: "POST",
                headers: { "content-type": contentType },
                body,
              }).formData(),
            )
          : JSON.parse(body.toString("utf8"));
        const method = request.url?.split("/").at(-1) ?? "";
        requests.push({ method, payload });
        response.setHeader("content-type", "application/json");
        response.setHeader("connection", "close");
        if (method === "editMessageText" && rejectEdit) {
          response.statusCode = 400;
          response.end(
            JSON.stringify({
              ok: false,
              error_code: 400,
              description: "Bad Request: message to edit not found",
            }),
          );
          return;
        }
        const result =
          method === "getChat"
            ? { ...groupChat, id: Number(payload.chat_id) }
            : [
                  "deleteMessage",
                  "setMessageReaction",
                  "sendChatAction",
                  "answerCallbackQuery",
                  "setMyCommands",
                  "deleteMyCommands",
                ].includes(method)
              ? true
              : {
                  message_id: method.startsWith("edit")
                    ? Number(payload.message_id)
                    : ++nextMessageId,
                  date: 1736380800,
                  chat: Number(payload.chat_id) === groupChat.id ? groupChat : chat,
                  ...(payload.message_thread_id === undefined
                    ? {}
                    : { message_thread_id: Number(payload.message_thread_id) }),
                };
        response.end(JSON.stringify({ ok: true, result }));
      })().catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  beforeEach(() => {
    requests.length = 0;
    nextMessageId = 700;
    rejectEdit = false;
    previousRegistry = getActivePluginRegistry();
    registry = createEmptyPluginRegistry();
    setActivePluginRegistry(registry);
  });

  afterEach(() => {
    resetGlobalHookRunner();
    resetTelegramClientOptionsCacheForTests();
    if (previousRegistry) {
      setActivePluginRegistry(previousRegistry);
    } else {
      resetPluginRuntimeStateForTest();
    }
  });

  function pluginConfig(): OpenClawConfig {
    const cfg = commandConfig();
    cfg.channels!.telegram!.apiRoot = apiRoot;
    return cfg;
  }

  function registerCommand(
    handler: OpenClawPluginCommandDefinition["handler"],
    options: { progress?: boolean; acceptsArgs?: boolean } = {},
  ) {
    const result = registerPluginCommand("delivery-test", {
      name: "plug",
      description: "Exercise registered delivery",
      acceptsArgs: options.acceptsArgs ?? true,
      requireAuth: false,
      ...(options.progress === false ? {} : { nativeProgressMessages: { telegram: "Working..." } }),
      handler,
    });
    if (!result.ok) {
      throw new Error(result.error);
    }
  }

  function effects() {
    return requests.filter(
      ({ method }) =>
        !["sendChatAction", "getChat", "setMyCommands", "deleteMyCommands"].includes(method),
    );
  }

  it.each([false, true])("settles a progress edit once (rejected: %s)", async (rejected) => {
    rejectEdit = rejected;
    const cfg = pluginConfig();
    cfg.channels!.telegram!.silentErrorReplies = rejected;
    const sent = vi.fn();
    addTestHook({ registry, pluginId: "delivery-test", hookName: "message_sent", handler: sent });
    initializeGlobalHookRunner(registry);
    registerCommand(async () =>
      rejected
        ? { text: "Deployment failed", isError: true }
        : {
            text: "Choose a deployment",
            channelData: { telegram: { buttons: [[{ text: "Deploy", callback_data: "deploy" }]] } },
          },
    );
    await (
      await createBot(true, true, cfg)
    ).handleUpdate({ update_id: 3200, message: commandMessage("/plug") });
    expect(effects().map(({ method }) => method)).toEqual(
      rejected
        ? ["sendMessage", "editMessageText", "deleteMessage", "sendMessage"]
        : ["sendMessage", "editMessageText"],
    );
    if (rejected) {
      expect(effects()[2]?.payload).toMatchObject({ message_id: 701 });
      expect(effects()[3]?.payload).toMatchObject({
        text: "Deployment failed",
        disable_notification: true,
      });
    } else {
      expect([chat.id, String(chat.id)]).toContain(effects()[1]?.payload.chat_id);
      expect(effects()[1]?.payload).toMatchObject({
        message_id: 701,
        text: "Choose a deployment",
        reply_markup: { inline_keyboard: [[{ text: "Deploy", callback_data: "deploy" }]] },
      });
      expect(sent).toHaveBeenCalledOnce();
      expect(sent.mock.calls[0]?.[0]).toMatchObject({
        success: true,
        messageId: "701",
        content: "Choose a deployment",
      });
    }
  });

  it("delivers plugin media only from the routed agent workspace", async () => {
    const root = mediaDirs.make("telegram-command-workspaces-", process.cwd());
    const routedWorkspace = join(root, "attachments");
    const otherWorkspace = join(root, "main");
    await fs.mkdir(routedWorkspace);
    await fs.mkdir(otherWorkspace);
    const allowed = join(routedWorkspace, "report.pdf");
    const forbidden = join(otherWorkspace, "private.pdf");
    const content = "%PDF-1.7\nRouted workspace report\n%%EOF";
    await fs.writeFile(allowed, content);
    await fs.writeFile(forbidden, "%PDF-1.7\nUnrelated workspace\n%%EOF");
    const cfg = pluginConfig();
    cfg.agents = {
      entries: {
        main: { workspace: otherWorkspace },
        attachments: { workspace: routedWorkspace },
      },
    };
    cfg.bindings = [{ agentId: "main", match: { channel: "telegram", accountId: "default" } }];
    cfg.channels!.telegram!.groupPolicy = "open";
    cfg.channels!.telegram!.groupAllowFrom = [String(from.id)];
    cfg.channels!.telegram!.groups = {
      "*": { requireMention: false, topics: { "77": { agentId: "attachments" } } },
    };
    let mediaUrl = allowed;
    registerCommand(async () => ({ text: "Workspace report", mediaUrl }));
    const bot = await createBot(true, true, cfg);
    await bot.handleUpdate({ update_id: 3210, message: groupCommand("/plug", 77) });
    expect(effects().map(({ method }) => method)).toEqual([
      "sendMessage",
      "deleteMessage",
      "sendDocument",
    ]);
    const payload = effects()[2]!.payload;
    const reference = String(payload.document);
    expect(reference).toMatch(/^attach:\/\//u);
    const upload = payload[reference.slice("attach://".length)];
    if (!(upload instanceof File)) {
      throw new Error("Telegram document did not reference its uploaded multipart file");
    }
    expect(await upload.text()).toBe(content);
    expect(payload.message_thread_id).toBe("77");
    const previousRequests = requests.length;
    mediaUrl = forbidden;
    await expect(
      bot.handleUpdate({ update_id: 3211, message: groupCommand("/plug", 77) }),
    ).rejects.toThrow(/not under an allowed directory/);
    expect(
      requests.slice(previousRequests).filter(({ method }) => method === "sendDocument"),
    ).toEqual([]);
  });

  it.each(["presentation", "reaction"] as const)(
    "cleans progress before delivering non-editable %s results",
    async (kind) => {
      const cfg = pluginConfig();
      cfg.channels!.telegram!.richMessages = kind === "presentation";
      const result: PluginCommandResult =
        kind === "reaction"
          ? { channelData: { telegram: { reaction: { emoji: "\u{1f44d}" } } } }
          : {
              presentation: {
                blocks: [
                  {
                    type: "table",
                    caption: "Deployment status",
                    headers: ["Job", "State"],
                    rows: [["Build", "Ready"]],
                  },
                  {
                    type: "buttons",
                    buttons: [{ label: "Deploy", action: { type: "command", command: "/deploy" } }],
                  },
                ],
              },
            };
      registerCommand(async () => result);
      await (
        await createBot(true, true, cfg)
      ).handleUpdate({
        update_id: 3201,
        message: { ...commandMessage("/plug"), message_id: 32101 },
      });
      expect(effects().map(({ method }) => method)).toEqual([
        "sendMessage",
        "deleteMessage",
        kind === "reaction" ? "setMessageReaction" : "sendRichMessage",
      ]);
      expect(effects()[1]?.payload).toMatchObject({ message_id: 701 });
      const delivered = effects()[2]?.payload;
      if (kind === "reaction") {
        expect(delivered).toMatchObject({
          message_id: 32101,
          reaction: [{ type: "emoji", emoji: "\u{1f44d}" }],
        });
      } else {
        expect(delivered).toMatchObject({
          reply_markup: { inline_keyboard: [[{ text: "Deploy", callback_data: "tgcmd:/deploy" }]] },
        });
        expect(JSON.stringify(delivered?.rich_message)).toContain("Ready");
        expect(JSON.stringify(delivered?.rich_message)).not.toContain("No response generated");
      }
    },
  );

  it.each(["explicit suppressReply", "metadata-only", "button-only"] as const)(
    "distinguishes %s results from an empty response",
    async (kind) => {
      const suppressed = kind === "explicit suppressReply";
      const cfg = pluginConfig();
      if (suppressed) {
        cfg.channels!.telegram!.execApprovals = {
          enabled: true,
          approvers: [String(from.id)],
          target: "dm",
        };
      }
      registerCommand(
        async () =>
          kind === "explicit suppressReply"
            ? { suppressReply: true }
            : kind === "metadata-only"
              ? { channelData: { plugin: { traceId: "trace-1" } } }
              : {
                  channelData: {
                    telegram: { buttons: [[{ text: "Retry", callback_data: "retry" }]] },
                  },
                },
        { progress: suppressed },
      );
      await (
        await createBot(true, true, cfg)
      ).handleUpdate({ update_id: 3203, message: commandMessage("/plug") });
      if (suppressed) {
        expect(effects()).toMatchObject([
          { method: "sendMessage" },
          { method: "deleteMessage", payload: { message_id: 701 } },
        ]);
      } else {
        expect(effects()).toHaveLength(1);
        const delivered = effects()[0]?.payload;
        if (kind === "button-only") {
          expect(delivered).toMatchObject({
            reply_markup: { inline_keyboard: [[{ text: "Retry", callback_data: "retry" }]] },
          });
          expect(delivered?.text).not.toContain("No response generated");
        } else {
          expect(delivered?.text).toContain("No response generated");
        }
      }
    },
  );

  it("rejects unmatched arguments outside a forum topic", async () => {
    registerCommand(
      async () => {
        throw new Error("Unmatched arguments must not execute");
      },
      {
        progress: false,
        acceptsArgs: false,
      },
    );
    const message = groupCommand("/plug unexpected");
    await (
      await createBot(true, true, pluginConfig())
    ).handleUpdate({
      update_id: 3205,
      message: {
        ...message,
        chat: { id: groupChat.id, type: "supergroup", title: "Forum" },
        message_thread_id: undefined,
        is_topic_message: false,
      },
    });
    expect(effects()).toEqual([
      {
        method: "sendMessage",
        payload: expect.objectContaining({
          text: "Command not found.",
        }),
      },
    ]);
    expect([groupChat.id, String(groupChat.id)]).toContain(effects()[0]?.payload.chat_id);
    expect(effects()[0]?.payload).not.toHaveProperty("message_thread_id");
    expect(harness.replySpy).not.toHaveBeenCalled();
  });

  it("lets a plugin read the persisted forum transcript despite a stale legacy file", async () => {
    const cfg = pluginConfig();
    cfg.channels!.telegram!.groupAllowFrom = [String(from.id)];
    cfg.channels!.telegram!.groups = { "*": { requireMention: false } };
    const sessionKey = `agent:main:telegram:group:${groupChat.id}:topic:77`;
    for (const [key, id, text] of [
      ["agent:main:main", "plugin-forum-wrong-session", "Wrong conversation"],
      [sessionKey, "plugin-forum-current-session", "Bound forum transcript answer"],
    ] as const) {
      await upsertSessionEntry({
        storePath: cfg.session!.store!,
        sessionKey: key,
        entry: { sessionId: id, sessionFile: "stale-legacy.jsonl", updatedAt: 1 },
      });
      await appendSessionTranscriptMessageByIdentity({
        agentId: "main",
        storePath: cfg.session!.store!,
        sessionKey: key,
        sessionId: id,
        message: { role: "assistant", content: text, timestamp: 1 },
        eventId: `${id}-assistant`,
      });
    }
    registerCommand(
      async (ctx) => {
        const marker = parseSqliteSessionFileMarker(ctx.sessionFile);
        if (!marker || !ctx.sessionId || !ctx.sessionKey) {
          return { text: "No usable transcript identity" };
        }
        const latest = await readLatestAssistantTextByIdentity({
          ...marker,
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionKey,
        });
        return { text: latest?.text ?? "No transcript found" };
      },
      { progress: false },
    );
    await (
      await createBot(true, true, cfg)
    ).handleUpdate({
      update_id: 3206,
      message: groupCommand("/plug", 77),
    });
    expect(effects()).toEqual([
      {
        method: "sendMessage",
        payload: expect.objectContaining({
          text: "Bound forum transcript answer",
          message_thread_id: 77,
        }),
      },
    ]);
  });
});

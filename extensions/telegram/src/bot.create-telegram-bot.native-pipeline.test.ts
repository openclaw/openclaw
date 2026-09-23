import { describe, expect, it, vi } from "vitest";
import {
  createBot,
  commandMessage,
  harness,
  chat,
  from,
  photo,
  apiCalls,
  groupChat,
  groupCommand,
} from "./bot.create-telegram-bot.native-pipeline.test-support.js";

const { loginExecutor } = vi.hoisted(() => ({ loginExecutor: vi.fn(async () => false) }));
vi.mock("./bot-native-command-login.js", () => ({ executeTelegramLoginCommand: loginExecutor }));
vi.mock("openclaw/plugin-sdk/agent-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-runtime")>()),
  loadPreparedModelCatalog: vi.fn(async () => []),
}));

describe("createTelegramBot typed command pipeline", () => {
  it("keeps the replied-to photo and quote on a native command turn", async () => {
    const bot = createBot();
    await bot.handleUpdate({
      update_id: 1001,
      message: {
        ...commandMessage("/btw check this pls"),
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
  });

  it("keeps caption commands in the message pipeline", async () => {
    const bot = createBot();
    const { text, entities, ...message } = commandMessage("/status");
    await bot.handleUpdate({
      update_id: 1002,
      message: { ...message, caption: text, caption_entities: entities, photo },
    });
    expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({
      CommandSource: "text",
      CommandBody: "/status",
      media: expect.arrayContaining([expect.objectContaining({ path: "/tmp/replied-photo.jpg" })]),
    });
  });

  it("renders the argument menu without dispatching a turn", async () => {
    const bot = createBot();
    await bot.handleUpdate({ update_id: 1003, message: commandMessage("/think") });
    expect(harness.replySpy).not.toHaveBeenCalled();
    expect(apiCalls).toHaveBeenCalledWith(
      "sendMessage",
      expect.objectContaining({
        reply_markup: expect.objectContaining({ inline_keyboard: expect.any(Array) }),
      }),
    );
  });

  it("dispatches completed thinking arguments through the message pipeline", async () => {
    const bot = createBot();
    await bot.handleUpdate({ update_id: 1005, message: commandMessage("/think high") });
    expect(harness.replySpy).toHaveBeenCalledTimes(1);
    expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({
      CommandSource: "native",
      CommandTurn: { kind: "native", body: "/think high" },
    });
    expect(apiCalls.mock.calls).not.toEqual(
      expect.arrayContaining([
        ["sendMessage", expect.objectContaining({ reply_markup: expect.anything() })],
      ]),
    );
  });

  it("runs the login executor without dispatching a turn", async () => {
    const bot = createBot();
    await bot.handleUpdate({ update_id: 1004, message: commandMessage("/login") });
    expect(loginExecutor).toHaveBeenCalledWith(expect.objectContaining({ commandText: "/login" }));
    expect(harness.replySpy).not.toHaveBeenCalled();
  });

  it("translates native command names while preserving arguments and raw text", async () => {
    const bot = createBot();
    await bot.handleUpdate({
      update_id: 1006,
      message: commandMessage("/export_session session-notes.html"),
    });
    expect(harness.replySpy).toHaveBeenCalledTimes(1);
    expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({
      CommandSource: "native",
      CommandBody: "/export-session session-notes.html",
      RawBody: "/export_session session-notes.html",
      CommandTurn: { kind: "native", body: "/export-session session-notes.html" },
    });
  });

  it("threads native command replies inside topics", async () => {
    harness.replySpy.mockResolvedValue({ text: "response" });
    const bot = createBot(true, true, {
      commands: { native: true },
      channels: {
        telegram: {
          dmPolicy: "open",
          allowFrom: ["*"],
          replyToMode: "first",
          streaming: { mode: "off" },
          groups: { "*": { requireMention: false } },
        },
      },
    });
    await bot.handleUpdate({ update_id: 1007, message: groupCommand() });
    const replies = apiCalls.mock.calls.filter(([method]) => method === "sendMessage");
    expect(replies).toHaveLength(1);
    expect(replies[0]?.[1]).toMatchObject({
      chat_id: String(groupChat.id),
      text: "response",
      message_thread_id: 99,
    });
    expect(replies[0]?.[1]).not.toHaveProperty("reply_parameters");
  });

  it("delivers progress for native slash commands through the message policy", async () => {
    harness.replySpy.mockImplementation(async (_ctx, opts) => {
      await opts?.onToolResult?.({
        text: "Fast mode enabled",
        channelData: { openclawProgressKind: "fast-mode-auto" },
      });
      return { text: "final reply" };
    });
    const bot = createBot();
    await bot.handleUpdate({ update_id: 1008, message: commandMessage("/verbose on") });
    const replies = apiCalls.mock.calls.filter(([method]) => method === "sendMessage");
    expect(replies).toHaveLength(2);
    expect(replies[0]?.[1]).toMatchObject({ text: expect.stringContaining("Fast mode enabled") });
    expect(replies[1]?.[1]).toMatchObject({ text: expect.stringContaining("final reply") });
  });

  it.each([
    {
      name: "keeps unconfigured dm topic commands on the flat dm session",
      messageThreadId: 99,
      dmTopicsEnabled: false,
      expectedSessionKey: "agent:main:main",
    },
    {
      name: "uses bot topic capability for native dm topic command target sessions",
      messageThreadId: 99,
      dmTopicsEnabled: true,
      expectedSessionKey: `agent:main:main:thread:${chat.id}:99`,
    },
    {
      name: "allows native DM commands for paired users",
      messageThreadId: undefined,
      dmTopicsEnabled: false,
      expectedSessionKey: "agent:main:main",
    },
  ])("$name", async ({ messageThreadId, dmTopicsEnabled, expectedSessionKey }) => {
    harness.replySpy.mockResolvedValue({ text: "response" });
    harness.getReadChannelAllowFromStoreMock().mockResolvedValue([String(from.id)]);
    const bot = createBot(
      true,
      true,
      {
        commands: { native: true },
        channels: {
          telegram: { dmPolicy: "pairing", autoTopicLabel: false, streaming: { mode: "off" } },
        },
      },
      dmTopicsEnabled,
    );
    await bot.handleUpdate({
      update_id: 1009,
      message: { ...commandMessage("/status"), message_thread_id: messageThreadId },
    });
    expect(harness.replySpy).toHaveBeenCalledTimes(1);
    expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({
      SessionKey: expectedSessionKey,
      CommandAuthorized: true,
    });
    expect(harness.getUpsertChannelPairingRequestMock()).not.toHaveBeenCalled();
    expect(apiCalls).not.toHaveBeenCalledWith(
      "sendMessage",
      expect.objectContaining({ text: "You are not authorized to use this command." }),
    );
  });

  it.each(["command allowlist", "owner"] as const)(
    "admits an unpaired sender authorized by the %s",
    async (grant) => {
      const bot = createBot(true, true, {
        commands: {
          native: true,
          ...(grant === "owner"
            ? { ownerAllowFrom: [`telegram:${from.id}`] }
            : { allowFrom: { telegram: [String(from.id)] } }),
        },
        channels: { telegram: { dmPolicy: "pairing", streaming: { mode: "off" } } },
      });
      await bot.handleUpdate({ update_id: 1010, message: commandMessage("/status") });
      expect(harness.replySpy).toHaveBeenCalledTimes(1);
      expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({ CommandAuthorized: true });
      expect(harness.getUpsertChannelPairingRequestMock()).not.toHaveBeenCalled();
      expect(harness.getReadChannelAllowFromStoreMock()).not.toHaveBeenCalled();
      expect(apiCalls).not.toHaveBeenCalledWith(
        "sendMessage",
        expect.objectContaining({ text: expect.stringContaining("Pairing code:") }),
      );
    },
  );

  it.each(["command allowlist", "owner"] as const)(
    "admits a sender outside the group allowlist authorized by the %s",
    async (grant) => {
      const bot = createBot(true, true, {
        commands: {
          native: true,
          ...(grant === "owner"
            ? { ownerAllowFrom: [`telegram:${from.id}`] }
            : { allowFrom: { telegram: [String(from.id)] } }),
        },
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            groupAllowFrom: ["99999"],
            streaming: { mode: "off" },
            groups: { "*": { requireMention: false } },
          },
        },
      });
      await bot.handleUpdate({ update_id: 1011, message: groupCommand() });
      expect(harness.replySpy).toHaveBeenCalledTimes(1);
      expect(harness.replySpy.mock.calls[0]?.[0]).toMatchObject({ CommandAuthorized: true });
      expect(harness.getReadChannelAllowFromStoreMock()).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    "keeps pairing challenges for unlisted senders with command allowlist configured=%s",
    async (configured) => {
      const bot = createBot(true, true, {
        commands: { native: true, ...(configured ? { allowFrom: { telegram: ["99999"] } } : {}) },
        channels: { telegram: { dmPolicy: "pairing" } },
      });
      await bot.handleUpdate({ update_id: 1012, message: commandMessage("/status") });
      expect(harness.replySpy).not.toHaveBeenCalled();
      expect(apiCalls).toHaveBeenCalledWith(
        "sendMessage",
        expect.objectContaining({ text: expect.stringContaining("Pairing code:") }),
      );
    },
  );

  it.each([true, false])(
    "silently drops unlisted group senders with command allowlist configured=%s",
    async (configured) => {
      const bot = createBot(true, true, {
        commands: { native: true, ...(configured ? { allowFrom: { telegram: ["99999"] } } : {}) },
        channels: {
          telegram: {
            groupPolicy: "allowlist",
            groupAllowFrom: ["99999"],
            groups: { "*": { requireMention: false } },
          },
        },
      });
      await bot.handleUpdate({ update_id: 1013, message: groupCommand() });
      expect(harness.replySpy).not.toHaveBeenCalled();
      expect(apiCalls.mock.calls.filter(([method]) => method === "sendMessage")).toEqual([]);
    },
  );

  it("keeps disabled topics closed to command-authorized senders", async () => {
    const bot = createBot(true, true, {
      commands: { native: true, allowFrom: { telegram: [String(from.id)] } },
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["99999"],
          groups: {
            [String(groupChat.id)]: {
              requireMention: false,
              topics: { "99": { enabled: false } },
            },
          },
        },
      },
    });
    await bot.handleUpdate({ update_id: 1014, message: groupCommand() });
    expect(harness.replySpy).not.toHaveBeenCalled();
    expect(apiCalls.mock.calls.filter(([method]) => method === "sendMessage")).toEqual([]);
  });

  it.each(
    (["group", "topic", "direct"] as const).flatMap((scope) =>
      (["command allowlist", "owner"] as const).flatMap((grant) =>
        [true, false].flatMap((included) =>
          ["/status", "/think"].map((command) => ({ scope, grant, included, command })),
        ),
      ),
    ),
  )(
    "enforces $scope sender scope for $grant: included=$included command=$command",
    async ({ scope, grant, included, command }) => {
      const allowFrom = [included ? String(from.id) : "99999"];
      const scopedConfig = scope === "topic" ? { topics: { "99": { allowFrom } } } : { allowFrom };
      const bot = createBot(true, true, {
        commands: {
          native: true,
          ...(grant === "owner"
            ? { ownerAllowFrom: [`telegram:${from.id}`] }
            : { allowFrom: { telegram: [String(from.id)] } }),
        },
        channels: {
          telegram: {
            dmPolicy: "pairing",
            groupPolicy: "allowlist",
            groupAllowFrom: ["99999"],
            streaming: { mode: "off" },
            ...(scope === "direct"
              ? { direct: { [String(chat.id)]: scopedConfig } }
              : {
                  groups: {
                    [String(groupChat.id)]: { requireMention: false, ...scopedConfig },
                  },
                }),
          },
        },
      });
      await bot.handleUpdate({
        update_id: 1016,
        message: scope === "direct" ? commandMessage(command) : groupCommand(command),
      });
      if (included && command === "/status") {
        expect(harness.replySpy).toHaveBeenCalledTimes(1);
      } else {
        expect(harness.replySpy).not.toHaveBeenCalled();
      }
      const menuReply = [
        "sendMessage",
        expect.objectContaining({
          reply_markup: expect.objectContaining({ inline_keyboard: expect.any(Array) }),
        }),
      ];
      if (included && command === "/think") {
        expect(apiCalls.mock.calls).toContainEqual(menuReply);
      } else {
        expect(apiCalls.mock.calls).not.toContainEqual(menuReply);
      }
      expect(harness.getUpsertChannelPairingRequestMock()).not.toHaveBeenCalled();
    },
  );

  it("keeps an explicit command allowlist authoritative for an owner", async () => {
    const bot = createBot(true, true, {
      commands: {
        native: true,
        ownerAllowFrom: [`telegram:${from.id}`],
        allowFrom: { telegram: ["99999"] },
      },
      channels: {
        telegram: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["99999"],
          groups: { "*": { requireMention: false } },
        },
      },
    });
    await bot.handleUpdate({ update_id: 1015, message: groupCommand() });
    expect(harness.replySpy).not.toHaveBeenCalled();
    expect(apiCalls.mock.calls.filter(([method]) => method === "sendMessage")).toEqual([]);
  });
});

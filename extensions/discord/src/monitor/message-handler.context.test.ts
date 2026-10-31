import { withRegisteredChannelIngress } from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { resolveCommandAuthorization } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, expect, it, vi } from "vitest";
import { discordPlugin } from "../../channel-plugin-api.js";
import * as discordRuntime from "../runtime.js";
import { resolveDiscordTextCommandAccess } from "./dm-command-auth.js";
import { buildDiscordMessageProcessContext as buildProcessContext } from "./message-handler.context.js";
import { createBaseDiscordMessageContext } from "./message-handler.test-harness.js";

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  shouldLogVerbose: () => true,
  logVerbose: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());

async function context(
  overrides: Record<string, unknown> = {},
  text = "hi",
  mediaList: Parameters<typeof buildProcessContext>[0]["mediaList"] = [],
) {
  const ctx = await createBaseDiscordMessageContext(overrides);
  const result = await buildProcessContext({ ctx, text, mediaList });
  expect(result).not.toBeNull();
  return result!.ctxPayload;
}

const image = { contentType: "image/png", kind: "image" } as const;
const resolvedImage = { ...image, path: "/tmp/ok.png" };
const video = { contentType: "video/mp4", kind: "video" } as const;

it("keeps inbound text out of verbose diagnostics while preserving the agent context", async () => {
  vi.mocked(logVerbose).mockClear();
  const text = "private-discord-message-contents";
  const payload = await context({ baseText: text, messageText: text }, text);
  expect(payload.Body).toContain(text);
  const diagnostics = vi.mocked(logVerbose).mock.calls.flat().join("\n");
  expect(diagnostics).not.toContain(text);
  expect(diagnostics).not.toContain("preview=");
});

it("preserves batched reply identities", async () => {
  const payload = await context({
    replyToMode: "batched",
    sourceMessageIds: ["1000", "1001"],
    canonicalMessageId: "pluralkit-original",
  });
  expect(payload).toMatchObject({
    MessageSid: "pluralkit-original",
    MessageSidFull: "1001",
    MessageSids: ["1000", "1001"],
    MessageSidFirst: "1000",
    MessageSidLast: "1001",
    ReplyThreading: { implicitCurrentMessage: "allow" },
  });
});

it("preserves bot sender scope and live owner authority through the host builder", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const senderId = "123456789012345678";
    const cfg: OpenClawConfig = {
      session: { store: state.path("sessions.json") },
      commands: { ownerAllowFrom: [`discord:${senderId}`] },
    };
    await withRegisteredChannelIngress(
      {
        plugin: discordPlugin,
        config: cfg,
        setRuntime: (runtime) => {
          vi.spyOn(discordRuntime, "getDiscordRuntime").mockReturnValue(runtime);
        },
      },
      async (runtime) => {
        const text = "/config show messages.responsePrefix";
        const ctx = await createBaseDiscordMessageContext(
          {
            cfg,
            inboundEventKind: "user_request",
            author: { id: senderId, username: "ada", bot: true },
            sender: { id: senderId, label: "Ada", name: "ada", isPluralKit: false },
            baseText: text,
            messageText: text,
            buildContext: runtime.channel.inbound.buildContext,
          },
          { storePath: state.path("sessions.json") },
        );
        ctx.resolveChannelIngress = (contextBinding, conversation) =>
          resolveDiscordTextCommandAccess({
            accountId: ctx.accountId,
            cfg,
            sender: { id: senderId, authorKind: "bot" },
            ownerAllowFrom: [senderId],
            memberAccessConfigured: true,
            memberAllowed: true,
            allowNameMatching: false,
            allowTextCommands: true,
            hasControlCommand: true,
            conversationId: ctx.messageChannelId,
            conversationParentId: conversation?.parentId,
            conversationThreadId: conversation?.threadId,
            contextBinding,
          });
        const result = await buildProcessContext({ ctx, text, mediaList: [] });
        if (!result) {
          throw new Error("expected a built Discord message context");
        }

        expect(result.ctxPayload.SenderIsBot).toBe(true);
        const authorization = resolveCommandAuthorization({
          ctx: result.ctxPayload,
          cfg,
          commandAuthorized: true,
        });
        expect(() => authorization.assertOwnerCurrent?.()).not.toThrow();
        cfg.commands = { ownerAllowFrom: [] };
        expect(() => authorization.assertOwnerCurrent?.()).toThrow("authority changed");
      },
    );
  });
});

it("does not mark PluralKit proxy senders as bots", async () => {
  const payload = await context({
    author: { id: "U1", username: "pk", bot: true },
    sender: { isPluralKit: true },
  });
  expect(payload.SenderIsBot).toBeUndefined();
});

it("preserves forwarded text once in history without treating it as a command", async () => {
  const guildHistories = new Map();
  const forwardedText = "[Forwarded message]\n/status forwarded task content\n<media:image>";
  const payload = await context(
    {
      baseText: "",
      messageText: forwardedText,
      guildHistories,
      historyLimit: 10,
      inboundEventKind: "room_event",
      message: {
        id: "m-forwarded",
        channelId: "c1",
        timestamp: new Date().toISOString(),
        attachments: [],
        message_snapshots: [{ message: { attachments: [{ id: "forwarded-image" }] } }],
      },
    },
    forwardedText,
    [{ path: "/tmp/forwarded.png", contentType: "image/png", kind: "image" }],
  );

  const entry = guildHistories.get("c1")?.[0];
  expect(entry?.body).toBe(forwardedText);
  expect(entry?.senderProvenance).toEqual({ id: "U1", name: "alice", memberRoleIds: [] });
  expect(Object.isFrozen(entry?.senderProvenance)).toBe(true);
  expect(Object.isFrozen(entry?.senderProvenance.memberRoleIds)).toBe(true);
  expect(payload).toMatchObject({
    BodyForAgent: forwardedText,
    RawBody: "",
    CommandBody: "",
    CommandTurn: { kind: "normal", source: "message", body: "" },
  });
});

it.each([
  [[image, resolvedImage], "[discord attachment unavailable]"],
  [[image, video], "[discord 2 attachments unavailable]"],
  [[resolvedImage], null],
] as const)("reports attachment availability for %j", async (media, notice) => {
  const payload = await context({}, "look at this", [...media]);
  for (const body of [payload.Body, payload.BodyForAgent]) {
    expect(body).toContain("look at this");
    if (notice) {
      expect(body).toContain(notice);
    } else {
      expect(body).not.toContain("unavailable");
    }
  }
});

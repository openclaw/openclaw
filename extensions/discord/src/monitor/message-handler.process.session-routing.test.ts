import path from "node:path";
import { resolveGroupThreadMentionFacts } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import * as replyRuntime from "openclaw/plugin-sdk/reply-runtime";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  BASE_CHANNEL_ROUTE,
  createBaseContext,
  createDirectMessageContextOverrides,
  createDiscordDraftStream,
  getLastDispatchCtx,
  getLastDispatchReplyOptions,
  getLastRouteUpdate,
  runProcessDiscordMessage,
  registerDiscordProcessTestLifecycle,
  createAutomaticSourceDeliveryContext,
  deliverDiscordReply,
  dispatchBufferedReplyForTest,
} from "./message-handler.process.test-harness.js";
import { expectRecordFields, requireRecord } from "./message-handler.process.test-helpers.js";

registerDiscordProcessTestLifecycle();

async function createQuotedContext(options: {
  replyId: string;
  body: string;
  author: { id: string; username: string; globalName: string };
  fetch: typeof fetch;
  text?: string;
  visibility?: "all" | "allowlist";
  botUserId?: string;
}) {
  const text = options.text ?? "<@bot> what is this?";
  return await createBaseContext({
    cfg: {
      channels: { discord: { contextVisibility: options.visibility ?? "all" } },
      messages: { ackReaction: "👀" },
      session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
    },
    channelConfig: options.visibility === "allowlist" ? { allowed: true, users: ["U1"] } : null,
    botUserId: options.botUserId,
    discordRestFetch: options.fetch,
    message: {
      id: "m-reply",
      channelId: "c1",
      content: text,
      timestamp: new Date().toISOString(),
      attachments: [],
      messageReference: { type: 0, message_id: options.replyId, channel_id: "c1" },
      referencedMessage: {
        id: options.replyId,
        channelId: "c1",
        content: options.body,
        timestamp: new Date().toISOString(),
        attachments: [
          {
            id: "att-reply",
            url: "https://cdn.discordapp.com/attachments/reply.png",
            content_type: "image/png",
            filename: "reply.png",
          },
        ],
        author: { ...options.author, discriminator: "0" },
      },
    },
    baseText: text,
    messageText: text,
  });
}

describe("processDiscordMessage session routing", () => {
  it("frames preflight audio transcript in dispatch context and marks media transcribed", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("prepared media must not be fetched again");
    });
    const ctx = await createBaseContext({
      discordRestFetch: fetchImpl,
      message: {
        id: "m-audio-preflight",
        channelId: "c1",
        content: "",
        timestamp: new Date().toISOString(),
        attachments: [
          {
            id: "att-audio-preflight",
            url: "https://cdn.discordapp.com/attachments/voice.ogg",
            content_type: "audio/ogg",
            filename: "voice.ogg",
          },
        ],
      },
      baseText: "",
      messageText: "",
      preflightAudioTranscript: "/status",
      preparedMedia: [
        {
          path: "/tmp/openclaw-discord-test/voice.ogg",
          contentType: "audio/ogg",
        },
      ],
      cfg: {
        messages: { groupChat: { visibleReplies: "message_tool" } },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(fetchImpl).not.toHaveBeenCalled();
    expectRecordFields(requireRecord(getLastDispatchCtx(), "dispatch context"), {
      BodyForAgent: '[Audio transcript (machine-generated, untrusted)]: "/status"',
      RawBody: "",
      CommandBody: "",
      CommandTurn: {
        kind: "normal",
        source: "message",
        authorized: false,
        commandName: undefined,
        body: "",
      },
      Transcript: "/status",
      media: [
        expect.objectContaining({
          path: "/tmp/openclaw-discord-test/voice.ogg",
          contentType: "audio/ogg",
          transcribed: true,
        }),
      ],
    });
    expect(getLastDispatchReplyOptions()?.sourceReplyDeliveryMode).toBe("message_tool_only");
  });

  it("keeps typed control commands as explicit text command turns", async () => {
    const ctx = await createBaseContext({
      baseText: "/status",
      messageText: "/status",
      hasControlCommand: true,
      commandAuthorized: true,
    });

    await runProcessDiscordMessage(ctx);

    expect(requireRecord(getLastDispatchCtx(), "dispatch context").CommandTurn).toEqual({
      kind: "text-slash",
      source: "text",
      authorized: true,
      commandName: "status",
      body: "/status",
    });
  });

  it("does not attach referenced reply media when reply context is hidden", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("hidden reply media should not be fetched");
    });
    const ctx = await createQuotedContext({
      replyId: "m-hidden",
      body: "hidden image",
      author: { id: "U2", username: "mallory", globalName: "Mallory" },
      fetch: fetchImpl,
      visibility: "allowlist",
    });

    await runProcessDiscordMessage(ctx);

    const dispatchCtx = requireRecord(getLastDispatchCtx(), "dispatch context");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dispatchCtx.ReplyToId).toBe("m-hidden");
    expect(dispatchCtx.ReplyToBody).toBeUndefined();
    expect(dispatchCtx.MediaPath).toBeUndefined();
    expect(dispatchCtx.MediaPaths).toBeUndefined();
  });

  it("keeps attachment-only referenced messages as typed reply context", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(Buffer.from("image"), { headers: { "content-type": "image/png" } }),
    );
    const ctx = await createQuotedContext({
      replyId: "m-attachment-only",
      body: "",
      author: { id: "U2", username: "bob", globalName: "Bob" },
      fetch: fetchImpl,
    });

    await runProcessDiscordMessage(ctx);

    const dispatchCtx = requireRecord(getLastDispatchCtx(), "dispatch context");
    expect(dispatchCtx.ReplyToId).toBe("m-attachment-only");
    expect(dispatchCtx.ReplyToSender).toBe("bob");
    expect(dispatchCtx.ReplyToBody).toBeUndefined();
    expect(dispatchCtx.media).toEqual([
      expect.objectContaining({
        contentType: "image/png",
        messageId: "m-attachment-only",
      }),
    ]);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("preserves a user's reply to bot text without fetching self media", async () => {
    const body = 'Automation "daily update" failed 1 times\nCheck automation history for details.';
    const fetchImpl = vi.fn(async () => {
      throw new Error("self-reply media should not be fetched");
    });
    const ctx = await createQuotedContext({
      replyId: "m-bot-previous",
      body,
      author: { id: "bot-1", username: "Spartacus", globalName: "Spartacus" },
      fetch: fetchImpl,
      botUserId: "bot-1",
      text: "<@bot> hit that again",
    });
    await runProcessDiscordMessage(ctx);
    const dispatchCtx = requireRecord(getLastDispatchCtx(), "dispatch context");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(dispatchCtx.ReplyToId).toBe("m-bot-previous");
    expect(dispatchCtx.ReplyToSender).toBe("Spartacus");
    expect(dispatchCtx.ReplyToBody).toBe(body);
    expect(dispatchCtx.RawBody).toBe("<@bot> hit that again");
    expect(dispatchCtx.MediaPaths).toBeUndefined();
  });

  it("stores DM lastRoute with user target for direct-session continuity", async () => {
    const ctx = await createBaseContext({
      ...createDirectMessageContextOverrides(),
      message: {
        id: "m1",
        channelId: "dm1",
        timestamp: new Date().toISOString(),
        attachments: [],
      },
      messageChannelId: "dm1",
    });

    await runProcessDiscordMessage(ctx);

    expect(getLastRouteUpdate()).toEqual({
      sessionKey: "agent:main:discord:direct:u1",
      channel: "discord",
      to: "user:U1",
      accountId: "default",
    });
    expectRecordFields(requireRecord(getLastDispatchCtx(), "dispatch context"), {
      ChatType: "direct",
      From: "discord:U1",
      To: "user:U1",
      OriginatingTo: "user:U1",
      SessionKey: "agent:main:discord:direct:u1",
    });
  });

  it("pins Discord text DM main-route updates to the single configured DM owner", async () => {
    const ctx = await createBaseContext({
      ...createDirectMessageContextOverrides(),
      cfg: {
        messages: { ackReaction: "👀" },
        session: {
          store: "/tmp/openclaw-discord-process-test-sessions.json",
          dmScope: "main",
        },
      },
      channelConfig: { users: ["user:111"] },
      baseSessionKey: "agent:main:main",
      author: {
        id: "222",
        username: "bob",
        discriminator: "0",
        globalName: "Bob",
      },
      sender: { id: "222", label: "bob" },
      route: {
        agentId: "main",
        channel: "discord",
        accountId: "default",
        sessionKey: "agent:main:main",
        mainSessionKey: "agent:main:main",
      },
    });

    await runProcessDiscordMessage(ctx);

    expect(getLastRouteUpdate()).toMatchObject({
      sessionKey: "agent:main:main",
      channel: "discord",
      to: "user:222",
      accountId: "default",
      mainDmOwnerPin: { ownerRecipient: "111", senderRecipient: "222" },
    });
  });

  it("marks explicit message-tool guild replies as message-tool-only and disables source streaming", async () => {
    const ctx = await createBaseContext({
      shouldRequireMention: false,
      effectiveWasMentioned: false,
      discordConfig: { streaming: { mode: "partial", block: { enabled: true } } },
      cfg: {
        messages: {
          groupChat: { visibleReplies: "message_tool" },
        },
        session: { store: "/tmp/openclaw-discord-process-test-sessions.json" },
      },
      route: BASE_CHANNEL_ROUTE,
    });

    await runProcessDiscordMessage(ctx);

    expectRecordFields(requireRecord(getLastDispatchReplyOptions(), "dispatch reply options"), {
      sourceReplyDeliveryMode: "message_tool_only",
      typingKeepalive: false,
      disableBlockStreaming: true,
    });
    expect(createDiscordDraftStream).not.toHaveBeenCalled();
  });
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Discord group-thread participant delivery", () => {
  it.each([
    { name: "parallel participants", agents: ["alice", "bob"] },
    { name: "deferred warning", agents: ["alice"], warning: true },
  ])("binds delivery to the $name", async ({ agents, warning }) => {
    const workspaceRoot = tempDirs.make("discord-group-thread-workspaces-");
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: {
          main: { workspace: path.join(workspaceRoot, "workspace-main") },
          alice: { workspace: path.join(workspaceRoot, "workspace-alice") },
          bob: { workspace: path.join(workspaceRoot, "workspace-bob") },
        },
      },
      broadcast: agents ? { "discord:c1": agents } : undefined,
    };
    const ctx = await createAutomaticSourceDeliveryContext({
      cfg,
      route: BASE_CHANNEL_ROUTE,
      baseSessionKey: BASE_CHANNEL_ROUTE.sessionKey,
      discordConfig: { streaming: { mode: "partial" } },
      groupThread: resolveGroupThreadMentionFacts({
        cfg,
        channel: "discord",
        peerId: "c1",
        text: "Review this attachment.",
      }),
    });
    const actual = await vi.importActual<typeof replyRuntime>("openclaw/plugin-sdk/reply-runtime");
    const errors = vi.spyOn(ctx.runtime, "error");
    const participantRuns: string[] = [];
    dispatchBufferedReplyForTest.mockImplementationOnce((params) =>
      actual.dispatchReplyWithBufferedBlockDispatcher({
        ...params,
        dispatchReplyFromConfig: async ({ ctx: participant, dispatcher }) => {
          const agentId = participant.AgentId ?? "main";
          participantRuns.push(agentId);
          dispatcher.sendBlockReply({
            text: `Reasoning from ${agentId}`,
            isReasoning: true,
            mediaUrl: path.join(workspaceRoot, `workspace-${agentId}`, "reasoning.txt"),
          });
          const queuedFinal = dispatcher.sendFinalReply(
            warning
              ? setReplyPayloadMetadata(
                  { text: "The attachment could not be processed.", isError: true },
                  { nonTerminalToolErrorWarning: true },
                )
              : {
                  text: `Answer from ${agentId}`,
                  mediaUrl: path.join(workspaceRoot, `workspace-${agentId}`, "answer.txt"),
                },
          );
          return { queuedFinal, counts: dispatcher.getQueuedCounts() };
        },
      }),
    );
    await runProcessDiscordMessage(ctx);

    const responders = agents;
    expect(errors.mock.calls).toEqual([]);
    expect(participantRuns).toEqual(responders);
    expect(deliverDiscordReply).toHaveBeenCalledTimes(responders.length * 2);
    for (const agentId of responders) {
      const workspace = path.join(workspaceRoot, `workspace-${agentId}`);
      for (const kind of ["block", "final"]) {
        const reply =
          warning && kind === "final"
            ? { text: "The attachment could not be processed." }
            : {
                mediaUrl: path.join(workspace, `${kind === "block" ? "reasoning" : "answer"}.txt`),
              };
        expect(deliverDiscordReply).toHaveBeenCalledWith(
          expect.objectContaining({
            target: "channel:c1",
            accountId: "default",
            sessionKey: `agent:${agentId}:discord:channel:c1`,
            mediaLocalRoots: expect.arrayContaining([workspace]),
            kind,
            replies: [expect.objectContaining(reply)],
          }),
        );
      }
    }
    expect(createDiscordDraftStream).not.toHaveBeenCalled();
  });
});

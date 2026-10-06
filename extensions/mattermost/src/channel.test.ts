import { requestUrl } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, ReplyPayload } from "../runtime-api.js";

const { sendMessageMattermostMock, mockFetchGuard } = vi.hoisted(() => ({
  sendMessageMattermostMock: vi.fn<typeof import("./mattermost/send.js").sendMessageMattermost>(),
  mockFetchGuard: vi.fn(async (p: { url: string; init?: RequestInit }) => {
    const response = await globalThis.fetch(p.url, p.init);
    return { response, release: async () => {}, finalUrl: p.url };
  }),
}));

vi.mock("./mattermost/send.js", () => ({
  sendMessageMattermost: sendMessageMattermostMock,
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", async () => ({
  ...(await vi.importActual<typeof import("openclaw/plugin-sdk/ssrf-runtime")>(
    "openclaw/plugin-sdk/ssrf-runtime",
  )),
  fetchWithSsrFGuard: mockFetchGuard,
}));

import { mattermostPlugin } from "./channel.js";
import {
  createMattermostReactionFetchMock,
  createMattermostTestConfig,
  withMockedGlobalFetch,
} from "./mattermost/reactions.test-helpers.js";
import type { MattermostConfig } from "./types.js";

const actions = mattermostPlugin.actions!;
const outbound = mattermostPlugin.outbound!;
const threading = mattermostPlugin.threading!;
type ActionContext = Parameters<NonNullable<typeof actions.handleAction>>[0];

function config(mattermost: MattermostConfig = {}): OpenClawConfig {
  const cfg = createMattermostTestConfig();
  return { channels: { mattermost: { ...cfg.channels?.mattermost, ...mattermost } } };
}

function action(overrides: Partial<ActionContext>): ActionContext {
  return { channel: "mattermost", action: "send", params: {}, cfg: config(), ...overrides };
}

async function sendPrepared(overrides: Partial<ActionContext>) {
  const ctx = action(overrides);
  const to = "channel:CHAN1";
  const text = typeof ctx.params.message === "string" ? ctx.params.message : "report";
  const payload = await actions.prepareSendPayload!({ ctx, to, payload: { text } });
  expect(payload).not.toBeNull();
  return outbound.sendPayload!({
    cfg: ctx.cfg,
    to,
    text,
    payload: payload!,
    accountId: ctx.accountId ?? undefined,
    mediaAccess: ctx.mediaAccess,
    mediaLocalRoots: ctx.mediaLocalRoots,
    mediaReadFile: ctx.mediaReadFile,
  });
}

async function render(
  payload: ReplyPayload & { presentation: NonNullable<ReplyPayload["presentation"]> },
) {
  return outbound.renderPresentation!({
    payload,
    presentation: payload.presentation,
    ctx: { cfg: config(), to: "channel:CHAN1", text: "", payload },
  });
}

function expectSend(text = "report") {
  expect(sendMessageMattermostMock).toHaveBeenCalledTimes(1);
  const [to, actualText, options] = sendMessageMattermostMock.mock.calls[0]!;
  expect(to).toBe("channel:CHAN1");
  expect(actualText).toBe(text);
  return options;
}

beforeEach(() => {
  sendMessageMattermostMock.mockReset();
  sendMessageMattermostMock.mockResolvedValue({
    messageId: "post-1",
    channelId: "channel-1",
    content: "report",
    receipt: {
      primaryPlatformMessageId: "post-1",
      platformMessageIds: ["post-1"],
      parts: [{ platformMessageId: "post-1", kind: "text", index: 0 }],
      sentAt: 1,
    },
  });
});

describe("Mattermost configuration and threading", () => {
  it("requires an explicit user namespace for direct targets", () => {
    const infer = mattermostPlugin.messaging!.inferTargetChatType!;
    expect(infer({ to: "user:owner" })).toBe("direct");
    expect(infer({ to: "channel:operators" })).toBe("channel");
    expect(infer({ to: "ambiguous" })).toBeUndefined();
  });

  it("keeps sibling resolution stable across named-account additions and edits", () => {
    const beta = { baseUrl: "https://beta.example.com", chatmode: "onmessage" as const };
    const before: OpenClawConfig = {
      channels: { mattermost: { replyToMode: "first", accounts: { beta } } },
    };
    const expected = mattermostPlugin.config.resolveAccount(before, "beta");
    for (const baseUrl of ["https://alpha.example.com", "https://alpha-new.example.com"]) {
      const after = {
        ...before,
        channels: {
          mattermost: { ...before.channels?.mattermost, accounts: { beta, alpha: { baseUrl } } },
        },
      };
      expect(mattermostPlugin.config.resolveAccount(after, "beta")).toEqual(expected);
    }
  });

  it("normalizes pairing allowlist entries", () => {
    const normalize = mattermostPlugin.pairing!.normalizeAllowEntry!;
    expect(normalize("  @Alice  ")).toBe("alice");
    expect(normalize("user:USER123")).toBe("user123");
    expect(normalize("  mattermost:USER123  ")).toBe("user123");
  });

  it("formats allowFrom entries", () => {
    expect(
      mattermostPlugin.config.formatAllowFrom!({
        cfg: {},
        allowFrom: [" @Alice ", " user:USER123 ", " mattermost:BOT999 "],
      }),
    ).toEqual(["@alice", "user123", "bot999"]);
  });

  it("builds tool context from the effective thread root", () => {
    const hasRepliedRef = { value: false };
    expect(
      threading.buildToolContext!({
        cfg: config(),
        accountId: "default",
        hasRepliedRef,
        context: {
          To: "channel:C1",
          ChatType: "channel",
          CurrentMessageId: "child-1",
          MessageThreadId: "root-1",
        },
      }),
    ).toEqual({
      currentChannelId: "channel:C1",
      currentThreadTs: "root-1",
      currentMessageId: "child-1",
      replyToMode: "all",
      hasRepliedRef,
      sameChannelThreadRequired: true,
    });
  });

  it("preserves first mode when the current post starts the thread", () => {
    expect(
      threading.buildToolContext!({
        cfg: config({ replyToMode: "first" }),
        accountId: "default",
        context: {
          To: "channel:C1",
          ChatType: "channel",
          CurrentMessageId: "post-1",
          MessageThreadId: "post-1",
        },
      })?.replyToMode,
    ).toBe("first");
  });

  it("matches bare channel ids against the active target", () => {
    const match = threading.matchesToolContextTarget!;
    const target = "tqfek9psh7fw8mpa5berwyytqw";
    expect(match({ target, toolContext: { currentChannelId: "channel:" + target } })).toBe(true);
    expect(
      match({ target, toolContext: { currentChannelId: "channel:kqfek9psh7fw8mpa5berwyytqw" } }),
    ).toBe(false);
  });

  it("exposes the effective reply root as the transport thread", () => {
    const resolve = threading.resolveReplyTransport!;
    expect(
      resolve({ cfg: {}, replyToId: "child-post", replyToIsExplicit: true, threadId: "root-post" }),
    ).toEqual({ replyToId: "root-post", threadId: "root-post" });
    expect(resolve({ cfg: {}, threadId: 42 })).toEqual({ replyToId: "42", threadId: "42" });
  });

  it("matches final delivery routing for existing threads and direct messages", () => {
    const resolve = threading.resolveReplyTransport!;
    expect(
      resolve({
        cfg: {},
        replyToId: "child-post",
        threadId: "root-post",
        replyDelivery: { chatType: "channel", replyToMode: "all" },
      }),
    ).toEqual({ replyToId: "root-post", threadId: "root-post" });
    expect(
      resolve({
        cfg: {},
        replyToId: "other-root",
        replyToIsExplicit: true,
        threadId: "ambient-root",
        replyDelivery: { chatType: "channel", replyToMode: "all" },
      }),
    ).toEqual({ replyToId: "other-root", threadId: "other-root" });
    expect(
      resolve({
        cfg: {},
        replyToId: "dm-post",
        replyDelivery: { chatType: "direct", replyToMode: "all" },
      }),
    ).toEqual({ replyToId: "dm-post", threadId: "dm-post" });
    expect(
      resolve({
        cfg: {},
        replyToId: "dm-post",
        replyDelivery: { chatType: "direct", replyToMode: "off" },
      }),
    ).toEqual({ replyToId: null, threadId: null });
  });

  it("extracts explicit and implicit send thread evidence", () => {
    expect(
      actions.extractToolSend!({ args: { action: "send", to: "channel:C1", replyTo: "root-1" } }),
    ).toMatchObject({ to: "channel:C1", threadId: "root-1" });
    expect(actions.extractToolSend!({ args: { action: "send", to: "channel:C1" } })).toMatchObject({
      to: "channel:C1",
      threadImplicit: true,
    });
  });

  it("resolves the active root for same-channel sends", () => {
    const resolve = threading.resolveAutoThreadId!;
    const toolContext = {
      currentChannelId: "channel:C1",
      currentThreadTs: "root-1",
      currentMessageId: "child-1",
      replyToMode: "all" as const,
    };
    expect(
      resolve({
        cfg: {},
        to: "channel:C1",
        replyToId: "child-1",
        toolContext: { ...toolContext, replyToMode: "off" },
      }),
    ).toBe("root-1");
    expect(resolve({ cfg: {}, to: "channel:C2", toolContext })).toBeUndefined();
    const bare = "tqfek9psh7fw8mpa5berwyytqw";
    expect(
      resolve({
        cfg: {},
        to: bare,
        toolContext: {
          currentChannelId: "channel:" + bare,
          currentThreadTs: "root-1",
          replyToMode: "all",
        },
      }),
    ).toBe("root-1");
    expect(resolve({ cfg: {}, to: "channel:C1", replyToId: "other-root", toolContext })).toBe(
      "other-root",
    );
    expect(
      resolve({
        cfg: {},
        to: "channel:C1",
        toolContext: {
          ...toolContext,
          currentMessageId: "root-1",
          replyToMode: "first",
          hasRepliedRef: { value: true },
        },
      }),
    ).toBeUndefined();
    expect(
      resolve({
        cfg: {},
        to: "channel:C1",
        toolContext: { ...toolContext, currentMessageId: "root-1", replyToMode: "batched" },
      }),
    ).toBeUndefined();
  });

  it("uses the configured default account's reply mode while keeping direct messages flat", () => {
    const cfg = config({
      defaultAccount: "alerts",
      replyToMode: "off",
      accounts: {
        alerts: {
          replyToMode: "all",
          botToken: "alerts-token",
          baseUrl: "https://alerts.example.com",
        },
      },
    });
    expect(threading.resolveReplyToMode!({ cfg, chatType: "channel" })).toBe("all");
    expect(threading.resolveReplyToMode!({ cfg, accountId: "alerts", chatType: "direct" })).toBe(
      "off",
    );
  });
});

describe("Mattermost actions", () => {
  it("isolates discovery to available selected accounts and honors account overrides", () => {
    const cfg = config({
      actions: { messages: false, reactions: false },
      accounts: {
        default: { actions: { messages: false, reactions: false } },
        work: { botToken: "work-token", actions: { messages: true, reactions: true } },
        broken: {
          botToken: {
            source: "env",
            provider: "default",
            id: "OPENCLAW_TEST_MISSING_MATTERMOST_TOKEN",
          },
        },
      },
    });
    expect(actions.describeMessageTool({ cfg })?.actions).toEqual(["send", "react", "read"]);
    expect(actions.describeMessageTool({ cfg, accountId: "default" })?.actions).toEqual(["send"]);
    expect(actions.describeMessageTool({ cfg, accountId: "work" })?.actions).toEqual([
      "send",
      "react",
      "read",
    ]);
    expect(actions.describeMessageTool({ cfg, accountId: "broken" })?.actions).toEqual([]);
  });

  it("declines native sends in favor of durable outbound delivery", () => {
    expect(actions.supportsAction!({ action: "react" })).toBe(true);
    expect(actions.supportsAction!({ action: "read" })).toBe(true);
    expect(actions.supportsAction!({ action: "send" })).toBe(false);
    expect(actions.describeMessageTool({ cfg: config() })?.schema).toBeUndefined();
  });

  it("blocks reactions disabled by the default account", async () => {
    await expect(
      actions.handleAction!(
        action({
          action: "react",
          params: { messageId: "POST1", emoji: "thumbsup" },
          cfg: config({
            actions: { reactions: true },
            accounts: { default: { actions: { reactions: false } } },
          }),
        }),
      ),
    ).rejects.toThrow("Mattermost reactions are disabled in config");
  });

  it("blocks reads disabled by the selected account before provider access", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      withMockedGlobalFetch(fetchImpl, () =>
        actions.handleAction!(
          action({
            action: "read",
            params: { target: "channel:CURRENT" },
            cfg: config({
              actions: { messages: true },
              accounts: { default: { actions: { messages: false } } },
            }),
            accountId: "default",
            conversationReadOrigin: "direct-operator",
          }),
        ),
      ),
    ).rejects.toThrow("Mattermost message reads are disabled in config");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads posts into the shared JSON result with normalized timestamps", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      expect(requestUrl(input)).toContain("/api/v4/channels/CURRENT/posts?per_page=2");
      return Response.json({
        order: ["post-2", "post-1"],
        posts: {
          "post-1": { id: "post-1", message: "older", create_at: 1_700_000_001_000 },
          "post-2": { id: "post-2", message: "newer", create_at: 1_700_000_002_000 },
        },
      });
    });
    const result = await withMockedGlobalFetch(fetchImpl, () =>
      actions.handleAction!(
        action({
          action: "read",
          params: { target: "channel:CURRENT", to: "channel:CURRENT", limit: 2 },
          cfg: config({ actions: { messages: true } }),
          accountId: "default",
          requesterAccountId: "default",
          conversationReadOrigin: "delegated",
          toolContext: {
            currentChannelProvider: "mattermost",
            currentChannelId: "channel:CURRENT",
          },
        }),
      ),
    );
    expect(result.details).toMatchObject({
      ok: true,
      channelId: "CURRENT",
      hasMore: false,
      messages: [
        { id: "post-2", message: "newer", timestampMs: 1_700_000_002_000 },
        { id: "post-1", message: "older", timestampMs: 1_700_000_001_000 },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid read cursors and limits before provider access", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const params of [
      { target: "channel:CURRENT", before: "p1", after: "p2" },
      { target: "channel:CURRENT", limit: 0 },
    ]) {
      await expect(
        withMockedGlobalFetch(fetchImpl, () =>
          actions.handleAction!(
            action({
              action: "read",
              params,
              cfg: config({ actions: { messages: true } }),
              accountId: "default",
              conversationReadOrigin: "direct-operator",
            }),
          ),
        ),
      ).rejects.toThrow();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a disabled account before reaction provider access", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      withMockedGlobalFetch(fetchImpl, () =>
        actions.handleAction!(
          action({
            action: "react",
            params: {
              target: "channel:CHAN1",
              to: "channel:CHAN1",
              messageId: "POST1",
              emoji: "thumbsup",
            },
            cfg: config({ accounts: { default: { enabled: false } } }),
            accountId: "default",
            conversationReadOrigin: "direct-operator",
          }),
        ),
      ),
    ).rejects.toThrow('Mattermost account "default" is disabled');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects disabled accounts before opaque target resolution provider access", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(
      withMockedGlobalFetch(fetchImpl, () =>
        mattermostPlugin.messaging!.targetResolver!.resolveTarget!({
          cfg: config({ accounts: { default: { enabled: false } } }),
          accountId: "default",
          input: "disabled12abcd1234abcd1234",
          normalized: "disabled12abcd1234abcd1234",
        }),
      ),
    ).rejects.toThrow('Mattermost account "default" is disabled');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "named channel add",
      target: "#town-square",
      to: "channel:CHAN1",
      mode: "add" as const,
      postChannelId: "CHAN1",
      emoji: "thumbsup",
      expected: "Reacted with :thumbsup: on POST1",
    },
    {
      label: "named user removal",
      target: "@alice",
      to: "user:PEER1",
      mode: "remove" as const,
      postChannelId: "DMCHAN1",
      channelType: "D",
      channelName: "BOT123__PEER1",
      emoji: "👍",
      expected: "Removed reaction :thumbsup: from POST1",
    },
  ])("uses the resolved target for $label", async (fixture) => {
    const fetchImpl = createMattermostReactionFetchMock({
      ...fixture,
      postId: "POST1",
      emojiName: "thumbsup",
    });
    const result = await withMockedGlobalFetch(fetchImpl, () =>
      actions.handleAction!(
        action({
          action: "react",
          accountId: "default",
          conversationReadOrigin: "delegated",
          params: {
            target: fixture.target,
            to: fixture.to,
            messageId: "POST1",
            emoji: fixture.emoji,
            remove: fixture.mode === "remove",
          },
        }),
      ),
    );
    expect(result.content).toEqual([{ type: "text", text: fixture.expected }]);
  });

  it("preserves skin tone when adding a raw glyph reaction", async () => {
    const fetchImpl = createMattermostReactionFetchMock({
      mode: "add",
      postId: "POST1",
      emojiName: "thumbsup_medium_skin_tone",
    });
    const result = await withMockedGlobalFetch(fetchImpl, () =>
      actions.handleAction!(
        action({
          action: "react",
          params: { messageId: "POST1", emoji: "👍🏽", remove: "true" },
          accountId: "default",
          conversationReadOrigin: "direct-operator",
        }),
      ),
    );
    expect(result.content).toEqual([
      { type: "text", text: "Reacted with :thumbsup_medium_skin_tone: on POST1" },
    ]);
    expect(result.details).toStrictEqual({});
  });

  it("carries provider attachment text through prepared payload delivery", async () => {
    await sendPrepared({ params: { attachmentText: "native attachment" } });
    expect(expectSend().attachmentText).toBe("native attachment");
  });

  it("forwards a prepared local attachment with trusted roots and a reader", async () => {
    const mediaReadFile = vi.fn(async () => Buffer.from("report"));
    await sendPrepared({
      params: { attachments: [{ filePath: "/tmp/workspace/report.md", buffer: "", base64: "  " }] },
      accountId: "default",
      mediaLocalRoots: ["/tmp/workspace"],
      mediaReadFile,
    });
    expect(expectSend()).toMatchObject({
      mediaUrl: "/tmp/workspace/report.md",
      mediaLocalRoots: ["/tmp/workspace"],
      mediaReadFile,
      requireMediaUpload: true,
    });
  });

  it.each([
    [
      "multiple media",
      { media_urls: ["/tmp/one.md", "/tmp/two.md"] },
      "supports one attachment per message",
    ],
    [
      "mixed supported and buffer",
      { attachments: [{ filePath: "/tmp/report.md" }, { buffer: "cmVwb3J0" }] },
      "buffer/base64",
    ],
  ])("rejects prepared %s attachments", async (_name, params, error) => {
    await expect(sendPrepared({ params })).rejects.toThrow(error);
    expect(sendMessageMattermostMock).not.toHaveBeenCalled();
  });
});

describe("Mattermost outbound", () => {
  it.each(["text", "payload"] as const)(
    "reports %s provider progress before bookkeeping fails",
    async (mode) => {
      const onDeliveryResult = vi.fn();
      const receipt = {
        primaryPlatformMessageId: "post-final",
        platformMessageIds: ["post-final"],
        parts: [{ platformMessageId: "post-final", kind: "text" as const, index: 0 }],
        sentAt: 1,
      };
      sendMessageMattermostMock.mockImplementationOnce(async (_to, _text, options) => {
        await options.onDeliveryResult?.({
          messageId: "post-final",
          channelId: "CHAN1",
          content: "provider-final",
          receipt,
        });
        throw new Error("activity store unavailable");
      });
      const ctx = {
        cfg: config(),
        to: "channel:CHAN1",
        text: "provider-final",
        onDeliveryResult,
        ...(mode === "text" ? { mediaUrl: "https://example.com/incidental.png" } : {}),
      };
      const pending =
        mode === "text"
          ? outbound.sendText!(ctx)
          : outbound.sendPayload!({
              ...ctx,
              payload: {
                text: ctx.text,
                channelData: { mattermost: { attachmentText: "attachment" } },
              },
            });
      await expect(pending).rejects.toThrow("activity store unavailable");
      expect(sendMessageMattermostMock.mock.calls[0]?.[2].mediaUrl).toBeUndefined();
      expect(onDeliveryResult).toHaveBeenCalledTimes(1);
      expect(onDeliveryResult).toHaveBeenCalledWith({
        channel: "mattermost",
        messageId: "post-final",
        target: { kind: "channel", id: "CHAN1" },
        content: "provider-final",
        receipt,
      });
    },
  );

  it("renders question guidance and the Gateway option index beside the buttons", async () => {
    const questionId = "ask_0123456789abcdef0123456789abcdef";
    const rendered = await render({
      presentationTextMode: "fallback",
      channelData: { askUser: { questionId, optionValues: ["staging", "production"] } },
      presentation: {
        blocks: [
          { type: "text", text: "Which environment?" },
          {
            type: "text",
            text: "- staging\n- production\n\nTap an option, or reply with the option number or text.",
          },
          {
            type: "buttons",
            buttons: [
              {
                label: "staging",
                action: { type: "question", questionId, optionValue: "staging" },
              },
              {
                label: "production",
                action: { type: "question", questionId, optionValue: "production" },
              },
            ],
          },
        ],
      },
    });
    expect(rendered?.text).toBe(
      "Which environment?\n\n- staging\n- production\n\nTap an option, or reply with the option number or text.\n\n- staging\n- production",
    );
    expect(rendered).toMatchObject({
      channelData: {
        mattermost: {
          presentationButtons: [
            [
              {
                text: "staging",
                context: { oc_question: true, question_id: questionId, option_index: 0 },
              },
              {
                text: "production",
                context: { oc_question: true, question_id: questionId, option_index: 1 },
              },
            ],
          ],
        },
      },
    });
  });

  it("delivers presentation buttons with required local media and preserves card receipts", async () => {
    const mediaReadFile = vi.fn(async () => Buffer.from("image"));
    const payload = await render({
      mediaUrl: "report.png",
      presentation: {
        blocks: [
          { type: "text", text: "Deploy finished" },
          {
            type: "buttons",
            buttons: [
              { label: "Open", value: "open", style: "primary" },
              { label: "Docs", url: "https://example.com/docs" },
            ],
          },
        ],
      },
    });
    sendMessageMattermostMock.mockResolvedValueOnce({
      messageId: "post-1",
      channelId: "channel-1",
      content: "card",
      receipt: {
        primaryPlatformMessageId: "post-1",
        platformMessageIds: ["post-1"],
        parts: [{ platformMessageId: "post-1", kind: "card", index: 0 }],
        sentAt: 1,
      },
    });
    const result = await mattermostPlugin.message!.send!.payload!({
      cfg: config(),
      to: "channel:CHAN1",
      text: "",
      payload: payload!,
      mediaAccess: {
        localRoots: ["/tmp/workspace"],
        readFile: mediaReadFile,
        workspaceDir: "/tmp/workspace",
      },
    });
    const options = expectSend("Deploy finished\n\n- Open\n- Docs: https://example.com/docs");
    expect(options).toMatchObject({
      mediaUrl: "report.png",
      mediaLocalRoots: ["/tmp/workspace"],
      mediaReadFile,
      workspaceDir: "/tmp/workspace",
      requireMediaUpload: true,
    });
    expect(options.buttons).toStrictEqual([
      [
        {
          id: "open",
          text: "Open",
          callback_data: "open",
          context: { callback_data: "open" },
          style: "primary",
        },
      ],
    ]);
    expect(result.receipt.platformMessageIds).toEqual(["post-1"]);
    expect(result.receipt.parts[0]?.kind).toBe("card");
  });

  it("keeps typed navigation and approval actions on the text delivery path", async () => {
    const payload = await render({
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Review", action: { type: "url", url: "https://example.com/review" } },
              { label: "Open app", action: { type: "web-app", url: "https://example.com/app" } },
              {
                label: "Allow",
                action: {
                  type: "approval",
                  approvalId: "approval-1",
                  approvalKind: "exec",
                  decision: "allow-once",
                },
                value: "/approve approval-1 allow-once",
              },
            ],
          },
        ],
      },
    });
    const text =
      "- Review: https://example.com/review\n- Open app: https://example.com/app\n- Allow";
    expect(payload?.text).toBe(text);
    expect(payload?.channelData?.mattermost).toBeUndefined();
    await outbound.sendPayload!({ cfg: config(), to: "channel:CHAN1", text, payload: payload! });
    const options = expectSend(text);
    expect(options.buttons).toBeUndefined();
    expect(JSON.stringify(options)).not.toContain("approval-1");
    expect(JSON.stringify(options)).not.toContain("/approve");
  });

  it("skips hosted widget actions without a Mattermost URL", async () => {
    expect(
      await render({
        presentation: {
          blocks: [
            { type: "text", text: "Widget" },
            {
              type: "buttons",
              buttons: [
                {
                  label: "Hosted widget",
                  action: { type: "web-app", widgetId: "AAAAAAAAAAAAAAAAAAAAAA" },
                },
              ],
            },
          ],
        },
      }),
    ).toBeNull();
  });

  it("keeps multi-media presentations on the fallback path", async () => {
    expect(
      await render({
        mediaUrls: ["https://example.com/1.png", "https://example.com/2.png"],
        presentation: {
          blocks: [{ type: "buttons", buttons: [{ label: "Open", value: "open" }] }],
        },
      }),
    ).toBeNull();
  });

  it("uses a thread as fallback for media delivery with structured workspace access", async () => {
    const mediaReadFile = vi.fn(async () => Buffer.from("image"));
    await outbound.sendMedia!({
      cfg: config(),
      to: "channel:CHAN1",
      text: "caption",
      mediaUrl: "image.png",
      threadId: "post-root",
      mediaAccess: {
        localRoots: ["/tmp/workspace"],
        readFile: mediaReadFile,
        workspaceDir: "/tmp/workspace",
      },
    });
    expect(expectSend("caption")).toMatchObject({
      replyToId: "post-root",
      mediaUrl: "image.png",
      mediaLocalRoots: ["/tmp/workspace"],
      mediaReadFile,
      workspaceDir: "/tmp/workspace",
      requireMediaUpload: true,
    });
  });
});

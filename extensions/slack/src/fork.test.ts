import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createStructuredOutboundPayloadPlan } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginRuntimeMock,
  createTestRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { getSessionBindingService } from "openclaw/plugin-sdk/session-binding-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterAll, afterEach, assert, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { resolveSlackAccount } from "./accounts.js";
import { slackPlugin } from "./channel.js";
import { registerSlackInstallationState } from "./installation-identity-state.js";
import { resolveSlackRoutingContext } from "./monitor/message-handler/prepare-routing.js";
import { setSlackRuntime } from "./runtime.js";
import { resolveSlackThreadContext } from "./threading.js";

const CHANNEL = "C12345678",
  ROOT = "1770000000.000001",
  MESSAGE = "1770000001.000002";
const NEW_ROOT = "1770000002.000003",
  SENDER = "U12345678",
  CHILD = "agent:main:fork:synthetic";
type ForkInput = Parameters<
  NonNullable<NonNullable<ChannelPlugin["conversationBindings"]>["prepareFork"]>
>[0];
type Request = { path: string; body: URLSearchParams; authorization?: string };
let state: OpenClawTestState;
let cfg: OpenClawConfig;
let installation: ReturnType<typeof registerSlackInstallationState>;
let requests: Request[];
let respond: (request: Request, response: ServerResponse) => object;
let live: boolean;
let caseId = 0;
function input(overrides: Partial<ForkInput> = {}): ForkInput {
  return {
    cfg,
    accountId: "work",
    source: { conversationId: ROOT, parentConversationId: CHANNEL, threadId: ROOT },
    sourceMessageId: MESSAGE,
    senderId: SENDER,
    isGroup: true,
    assertCurrent: () => {
      if (!live) {
        throw new Error("command revoked");
      }
    },
    ...overrides,
  };
}
function prepare(overrides: Partial<ForkInput> = {}) {
  const adapter = slackPlugin.conversationBindings?.prepareFork;
  assert(adapter, "Slack must expose native /fork through conversationBindings.prepareFork");
  return adapter(input(overrides));
}
async function handle(request: IncomingMessage, response: ServerResponse) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
  }
  const captured = {
    path: request.url ?? "",
    body: new URLSearchParams(body),
    authorization: request.headers.authorization,
  };
  requests.push(captured);
  const payload = respond(captured, response);
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(payload));
}
function reply(request: Request) {
  switch (request.path) {
    case "/api/conversations.info":
      return {
        ok: true,
        channel: { id: CHANNEL, is_channel: true, is_member: true, is_private: true },
      };
    case "/api/conversations.replies":
      return { ok: true, messages: [{ ts: ROOT }, { ts: MESSAGE, thread_ts: ROOT, user: SENDER }] };
    case "/api/chat.postMessage":
      return { ok: true, channel: CHANNEL, ts: NEW_ROOT };
    case "/api/chat.getPermalink":
      return {
        ok: true,
        permalink: "https://synthetic.slack.com/archives/C12345678/p1770000002000003",
      };
    default:
      throw new Error("unexpected Slack endpoint " + request.path);
  }
}
function withApi(run: () => Promise<void>) {
  return withServer(
    (req, res) => {
      void handle(req, res);
    },
    async (baseUrl) => {
      vi.stubEnv("SLACK_API_URL", baseUrl + "/api/");
      await run();
    },
  );
}
beforeAll(async () => {
  state = await createOpenClawTestState({ label: "slack-fork" });
});
afterAll(async () => {
  await state.cleanup();
});
beforeEach(() => {
  vi.stubEnv("OPENCLAW_STATE_DIR", state.path(String(caseId++)));
  cfg = {
    channels: {
      slack: {
        accounts: {
          work: {
            botToken: "xoxb-synthetic-fork",
            userToken: "xoxp-synthetic-read",
            groupPolicy: "open",
          },
        },
      },
    },
  };
  live = true;
  requests = [];
  respond = reply;
  for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) {
    vi.stubEnv(name, undefined);
  }
  vi.stubEnv("NO_PROXY", "*");
  setSlackRuntime(createPluginRuntimeMock({ config: { current: () => cfg } }));
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "slack", source: "test", plugin: slackPlugin }]),
  );
  installation = registerSlackInstallationState("work", "workspace", "T12345678");
});
afterEach(async () => {
  installation.release();
  await closeOpenClawStateDatabaseAsync();
  resetPluginRuntimeStateForTest();
  vi.unstubAllEnvs();
});

it("creates a literal same-channel root, binds its returned identity, and routes a reply after storage restart", async () => {
  await withApi(async () => {
    const title = "Branch <@U99999999> <!channel> & *literal* https://example.invalid";
    const prepared = await prepare({ title });
    assert(prepared.ok);
    const created = await prepared.create(CHILD);
    expect(created).toMatchObject({
      binding: {
        targetKind: "session",
        targetSessionKey: CHILD,
        conversation: {
          channel: "slack",
          accountId: "work",
          conversationId: NEW_ROOT,
          parentConversationId: CHANNEL,
        },
      },
      url: "https://synthetic.slack.com/archives/C12345678/p1770000002000003",
    });
    expect(await prepared.create(CHILD)).toEqual(created);
    const sourceRead = requests.find((r) => r.path === "/api/conversations.replies");
    expect(sourceRead?.authorization).toBe("Bearer xoxp-synthetic-read");
    expect(Object.fromEntries(sourceRead!.body)).toMatchObject({
      channel: CHANNEL,
      ts: ROOT,
      oldest: MESSAGE,
      latest: MESSAGE,
      inclusive: "true",
    });
    const permalinkRead = requests.find((r) => r.path === "/api/chat.getPermalink");
    expect(Object.fromEntries(permalinkRead!.body)).toMatchObject({
      channel: CHANNEL,
      message_ts: NEW_ROOT,
    });
    const posts = requests.filter((r) => r.path === "/api/chat.postMessage");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.authorization).toBe("Bearer xoxb-synthetic-fork");
    expect(posts[0]?.body.get("channel")).toBe(CHANNEL);
    expect(posts[0]?.body.has("thread_ts")).toBe(false);
    expect(JSON.parse(posts[0]!.body.get("blocks")!)).toEqual([
      { type: "section", text: { type: "plain_text", text: title, emoji: false } },
    ]);
    for (const field of ["mrkdwn", "unfurl_links", "unfurl_media", "link_names"]) {
      expect(posts[0]?.body.get(field)).toBe("false");
    }
    expect(posts[0]?.body.get("parse")).toBe("none");
    const recap =
      "User: <@U99999999> <!here> & **literal** https://example.invalid [[reply_to:123]]";
    assert(prepared.formatRecap);
    const plan = createStructuredOutboundPayloadPlan([prepared.formatRecap(recap)])[0];
    const sendPayload = slackPlugin.outbound?.sendPayload;
    assert(plan && sendPayload);
    const sent = await sendPayload({
      cfg,
      accountId: "work",
      to: CHANNEL,
      text: recap,
      threadId: NEW_ROOT,
      payload: plan.payload,
    });
    expect(sent.messageId).toBe(NEW_ROOT);
    const recapPost = requests.filter((r) => r.path === "/api/chat.postMessage")[1];
    expect(recapPost?.body.get("thread_ts")).toBe(NEW_ROOT);
    expect(JSON.parse(recapPost!.body.get("blocks")!)).toEqual([
      { type: "section", text: { type: "plain_text", text: recap, emoji: false } },
    ]);
    expect(recapPost?.body.get("text")).toContain("&lt;@U99999999&gt;");
    expect(recapPost?.body.get("unfurl_links")).toBe("false");
    expect(recapPost?.body.get("unfurl_media")).toBe("false");
    await closeOpenClawStateDatabaseAsync();
    const routing = await resolveSlackRoutingContext({
      ctx: { cfg, teamId: "T12345678", threadInheritParent: false, threadHistoryScope: "thread" },
      account: resolveSlackAccount({ cfg, accountId: "work" }),
      message: {
        type: "message",
        channel: CHANNEL,
        user: SENDER,
        ts: "1770000003.000004",
        thread_ts: NEW_ROOT,
      },
      chatType: "channel",
    });
    expect(routing.sessionKey).toBe(CHILD);
    expect(routing.runtimeBinding?.targetKind).toBe("session");
  });
});

it("refuses synthetic top-level threads, DMs, source-less native slash contexts and org installs without requests", async () => {
  const synthetic = resolveSlackThreadContext({
    message: { type: "message", channel: CHANNEL, ts: MESSAGE },
    replyToMode: "all",
  });
  const cases: Partial<ForkInput>[] = [
    { source: { conversationId: CHANNEL } },
    {
      source: {
        conversationId: synthetic.messageThreadId!,
        parentConversationId: CHANNEL,
        threadId: synthetic.messageThreadId,
      },
    },
    {
      isGroup: false,
      source: { conversationId: ROOT, parentConversationId: "D12345678", threadId: ROOT },
    },
    { sourceMessageId: "trigger-id" },
    { sourceMessageId: undefined },
    { source: { conversationId: ROOT, parentConversationId: "user:U12345678", threadId: ROOT } },
    { title: "x".repeat(3001) },
  ];
  await withApi(async () => {
    for (const value of cases) {
      expect((await prepare(value)).ok).toBe(false);
    }
    installation.update("enterprise");
    expect((await prepare()).ok).toBe(false);
    expect(requests).toEqual([]);
  });
});

it.each(["wrong-native-thread", "wrong-native-sender", "not-member", "mpim", "archived"])(
  "refuses %s before native writes",
  async (scenario) => {
    respond = (request) => {
      if (request.path === "/api/conversations.replies") {
        return {
          ok: true,
          messages: [
            {
              ts: MESSAGE,
              thread_ts: scenario === "wrong-native-thread" ? "1779999999.000001" : ROOT,
              user: scenario === "wrong-native-sender" ? "U_OTHER" : SENDER,
            },
          ],
        };
      }
      return {
        ok: true,
        channel: {
          id: CHANNEL,
          is_channel: true,
          is_member: scenario !== "not-member",
          is_mpim: scenario === "mpim",
          is_archived: scenario === "archived",
        },
      };
    };
    await withApi(async () => {
      expect((await prepare()).ok).toBe(false);
      expect(requests.every((r) => r.path.startsWith("/api/conversations."))).toBe(true);
      expect(await getSessionBindingService().listBySessionAsync(CHILD)).toEqual([]);
    });
  },
);

it.each(["command", "installation", "replacement", "credentials"])(
  "rechecks live %s authority after preparation",
  async (scenario) => {
    await withApi(async () => {
      const prepared = await prepare();
      assert(prepared.ok);
      if (scenario === "command") {
        live = false;
      }
      if (scenario === "installation") {
        installation.update("enterprise");
      }
      if (scenario === "replacement") {
        installation = registerSlackInstallationState("work", "workspace", "T12345678");
      }
      if (scenario === "credentials") {
        cfg = { channels: { slack: { accounts: { work: { botToken: "xoxb-rotated" } } } } };
      }
      assert(prepared.assertCurrent);
      expect(prepared.assertCurrent).toThrow();
      await expect(prepared.create(CHILD)).rejects.toThrow();
      expect(requests.some((r) => r.path === "/api/chat.postMessage")).toBe(false);
    });
  },
);

it("does not retry an ambiguous native root creation or bind an unknown root", async () => {
  respond = (request, response) => {
    if (request.path === "/api/chat.postMessage") {
      response.statusCode = 503;
      return { ok: false };
    }
    return reply(request);
  };
  await withApi(async () => {
    const prepared = await prepare();
    assert(prepared.ok);
    await expect(prepared.create(CHILD)).rejects.toThrow(/not confirmed|uncertain/i);
    await expect(prepared.create(CHILD)).rejects.toThrow();
    expect(requests.filter((r) => r.path === "/api/chat.postMessage")).toHaveLength(1);
    expect(await getSessionBindingService().listBySessionAsync(CHILD)).toEqual([]);
  });
});

it("retains a confirmed root identity when authority is revoked before binding", async () => {
  respond = (request) => {
    const payload = reply(request);
    if (request.path === "/api/chat.postMessage") {
      live = false;
    }
    return payload;
  };
  await withApi(async () => {
    const prepared = await prepare();
    assert(prepared.ok);
    await expect(prepared.create(CHILD)).rejects.toThrow(CHANNEL + "/" + NEW_ROOT);
    expect(requests.filter((r) => r.path === "/api/chat.postMessage")).toHaveLength(1);
    expect(await getSessionBindingService().listBySessionAsync(CHILD)).toEqual([]);
  });
});

it("preserves a committed binding and known root if permalink lookup fails", async () => {
  respond = (request) =>
    request.path === "/api/chat.getPermalink"
      ? { ok: false, error: "message_not_found" }
      : reply(request);
  await withApi(async () => {
    const prepared = await prepare();
    assert(prepared.ok);
    const created = await prepared.create(CHILD);
    expect(created.binding.targetSessionKey).toBe(CHILD);
    expect(created.url).toBeUndefined();
    expect(created.notice).toContain(CHANNEL + "/" + NEW_ROOT);
    expect(requests.filter((r) => r.path === "/api/chat.postMessage")).toHaveLength(1);
  });
});

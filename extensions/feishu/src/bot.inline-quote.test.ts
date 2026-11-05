import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./bot.cleanup.test-support.js";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import { handleFeishuMessage } from "./bot.js";
import {
  createFeishuTestConfig,
  createFeishuTestEvent,
  withFeishuRuntimeDefaults,
} from "./bot.test-support.js";
import { setFeishuRuntime } from "./runtime.js";

const { requests, restoreAdapter } = vi.hoisted(() => ({
  restoreAdapter: vi.fn(),
  requests: [] as { url: string; data: unknown }[],
}));
// mock-isolation: retain the real SDK serializer; replace only its HTTP transport.
vi.mock("@larksuiteoapi/node-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@larksuiteoapi/node-sdk")>();
  const { defaultHttpInstance } = actual;
  const originalAdapter = defaultHttpInstance.defaults.adapter;
  restoreAdapter.mockImplementation(() => {
    defaultHttpInstance.defaults.adapter = originalAdapter;
  });
  defaultHttpInstance.defaults.adapter = async (config) => {
    const url = config.url ?? "";
    requests.push({ url, data: config.data });
    let data;
    if (url.includes("tenant_access_token")) {
      data = { code: 0, tenant_access_token: "fixture-token", expire: 7200 };
    } else if (url.endsWith("/messages/om_quoted")) {
      data = {
        code: 0,
        data: {
          items: [
            {
              message_id: "om_quoted",
              chat_id: "oc_fixture",
              msg_type: "text",
              body: { content: JSON.stringify({ text: "quoted original" }) },
              sender: { id: "cli_fixture", sender_type: "app", id_type: "app_id" },
            },
          ],
        },
      };
    } else if (url.endsWith("/chats/oc_fixture")) {
      data = { code: 0, data: { name: "Fixture group" } };
    } else if (url.endsWith("/reply")) {
      data = { code: 0, data: { message_id: "om_out", chat_id: "oc_fixture" } };
    } else if (url.includes("/cardkit/")) {
      data = { code: 0, data: { card_id: "card_fixture" } };
    } else {
      throw new Error(`Unexpected isolated Feishu request: ${url}`);
    }
    return { data, status: 200, statusText: "OK", headers: {}, config };
  };
  return actual;
});
afterAll(() => {
  restoreAdapter();
  vi.doUnmock("@larksuiteoapi/node-sdk");
});

const guardedFetch = ssrfRuntime.fetchWithSsrFGuard;
afterEach(() => vi.restoreAllMocks());

let cfg: ClawdbotConfig;
const dispatch = vi.fn<
  PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"]
>(async ({ dispatcherOptions, replyOptions }) => {
  await dispatcherOptions.onReplyStart?.();
  await replyOptions?.onPartialReply?.({ text: "fixture answer" });
  await dispatcherOptions.deliver({ text: "fixture answer" }, { kind: "final" });
  return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
});

beforeEach(() => {
  // Keep SSRF validation/release real; inject hermetic DNS and HTTP at its I/O boundary.
  vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation((params) =>
    guardedFetch({
      ...params,
      lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
      fetchImpl: withFetchPreconnect(
        vi.fn<typeof fetch>(async (input, init) => {
          const url = input instanceof Request ? input.url : String(input);
          requests.push({ url, data: init?.body });
          const data = url.endsWith("/tenant_access_token/internal")
            ? { code: 0, tenant_access_token: "fixture-token", expire: 7200 }
            : url.includes("/cardkit/v1/cards")
              ? { code: 0, data: { card_id: "card_fixture" } }
              : undefined;
          if (!data) {
            throw new Error(`Unexpected isolated streaming request: ${url}`);
          }
          return new Response(JSON.stringify(data), {
            headers: { "Content-Type": "application/json" },
          });
        }),
      ),
    }),
  );
  requests.length = 0;
  dispatch.mockClear();
  setFeishuRuntime(
    createPluginRuntimeMock({
      config: { current: () => cfg },
      channel: {
        inbound: { buildContext: buildChannelInboundEventContext },
        reply: { dispatchReplyWithBufferedBlockDispatcher: dispatch },
        routing: { resolveAgentRoute },
      },
    }),
  );
});

const cases = [
  {
    name: "default group",
    scope: "group",
    mode: undefined,
    chatType: "group",
    threadId: undefined,
    inThread: false,
  },
  {
    name: "disabled group",
    scope: "group",
    mode: "disabled",
    chatType: "group",
    threadId: undefined,
    inThread: false,
  },
  {
    name: "default sender",
    scope: "group_sender",
    mode: undefined,
    chatType: "group",
    threadId: undefined,
    inThread: false,
  },
  {
    name: "disabled sender",
    scope: "group_sender",
    mode: "disabled",
    chatType: "group",
    threadId: undefined,
    inThread: false,
  },
  {
    name: "existing thread",
    scope: "group",
    mode: "disabled",
    chatType: "group",
    threadId: "omt_existing",
    inThread: true,
  },
  {
    name: "topic group root fallback",
    scope: "group",
    mode: "disabled",
    chatType: "topic_group",
    threadId: undefined,
    inThread: true,
  },
  {
    name: "explicit enabled",
    scope: "group",
    mode: "enabled",
    chatType: "group",
    threadId: undefined,
    inThread: true,
  },
] as const;

describe.each([false, true])("received quotes with streaming=%s", (streaming) => {
  it.each(cases)("$name preserves reply mode, ancestry, target, and session", async (testCase) => {
    cfg = withFeishuRuntimeDefaults(
      createFeishuTestConfig({
        enabled: true,
        appId: "cli_fixture",
        appSecret: "fixture-secret",
        groupPolicy: "open",
        requireMention: false,
        resolveSenderNames: false,
        typingIndicator: false,
        groupSessionScope: testCase.scope,
        replyInThread: testCase.mode,
        renderMode: streaming ? "card" : "raw",
        streaming: { mode: streaming ? "partial" : "off" },
      }),
    );
    const messageId = `om_inbound_${streaming ? "stream" : "text"}_${testCase.name.replaceAll(" ", "_")}`;
    const event = createFeishuTestEvent({
      messageId,
      senderOpenId: "ou_fixture",
      chatId: "oc_fixture",
      chatType: testCase.chatType,
      message: { root_id: "om_quoted", parent_id: "om_quoted", thread_id: testCase.threadId },
    });
    await handleFeishuMessage({ cfg, event, botOpenId: "ou_bot", runtime: createRuntimeEnv() });
    expect(dispatch).toHaveBeenCalledTimes(1);
    const call = dispatch.mock.calls[0];
    if (!call) {
      throw new Error("Received-message handler did not dispatch a reply");
    }
    const context = call[0].ctx;
    expect(context.RootMessageId).toBe("om_quoted");
    expect(context.Body).toContain("quoted original");
    expect(context.SessionKey).toBe(
      "agent:main:feishu:group:oc_fixture" +
        (testCase.scope === "group_sender" ? ":sender:ou_fixture" : ""),
    );
    const replies = requests.filter(({ url }) => url.endsWith("/reply"));
    expect(replies.length).toBeGreaterThan(0);
    const target = testCase.mode === "enabled" ? "om_quoted" : messageId;
    for (const reply of replies) {
      expect(reply.url).toContain(`/messages/${target}/reply`);
      expect(typeof reply.data).toBe("string");
      const body = JSON.parse(String(reply.data));
      if (streaming) {
        expect(body.msg_type).toBe("interactive");
        expect(JSON.parse(body.content)).toEqual({
          type: "card",
          data: { card_id: "card_fixture" },
        });
      }
      if (process.env.FEISHU_INLINE_QUOTE_CAPTURE === "1") {
        console.info(
          "FEISHU_SDK_CAPTURE",
          JSON.stringify({
            scenario: testCase.name,
            streaming,
            url: reply.url,
            serialized: reply.data,
            sessionKey: context.SessionKey,
            rootMessageId: context.RootMessageId,
          }),
        );
      }
      expect(body.reply_in_thread).toBe(testCase.inThread ? true : undefined);
    }
    expect(requests.some(({ url }) => url.includes("/cardkit/"))).toBe(streaming);
  });
});

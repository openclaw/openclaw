import { projectAgentToolActivity } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  chunkMarkdownTextWithMode,
  chunkTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "openclaw/plugin-sdk/reply-chunking";
import { createPluginRuntimeStore, type PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import * as ssrfRuntime from "openclaw/plugin-sdk/ssrf-runtime";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFeishuReplyDispatcher } from "./reply-dispatcher.js";

const { createMessage, deleteMessage } = vi.hoisted(() => ({
  createMessage: vi.fn(async () => ({ code: 0, data: { message_id: "om_tool_glyph" } })),
  deleteMessage: vi.fn(async () => ({ code: 0 })),
}));

vi.mock("./client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./client.js")>()),
  createFeishuClient: () => ({
    im: { message: { create: createMessage, delete: deleteMessage } },
  }),
}));

describe("Feishu tool progress glyphs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([
    { name: "exec", toolCallId: "exec-1", expected: "🛠️ Exec" },
    { name: "web_search", toolCallId: "search-1", expected: "🔎 Web Search" },
  ] as const)("puts $expected on the dispatched card", async ({ name, toolCallId, expected }) => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    vi.spyOn(ssrfRuntime, "fetchWithSsrFGuard").mockImplementation(async ({ url, init }) => {
      const path = new URL(url).pathname;
      if (typeof init?.body !== "string") {
        throw new Error("Expected a serialized Feishu request body");
      }
      requests.push({ path, body: JSON.parse(init.body) as Record<string, unknown> });
      const data = path.includes("/auth/")
        ? { tenant_access_token: "owned-fixture-token", expire: 7200 }
        : { data: { card_id: "owned-tool-glyph-card" } };
      return {
        response: new Response(JSON.stringify({ code: 0, ...data }), {
          headers: { "content-type": "application/json" },
        }),
        finalUrl: url,
        release: async () => {},
      };
    });
    const runtimeStore = createPluginRuntimeStore<PluginRuntime>({
      pluginId: "feishu",
      errorMessage: "Feishu runtime not initialized",
    });
    const previousRuntime = runtimeStore.tryGetRuntime();
    const runtime = createPluginRuntimeMock();
    Object.assign(runtime.channel.text, {
      resolveTextChunkLimit,
      resolveChunkMode,
      chunkTextWithMode,
      chunkMarkdownTextWithMode,
      convertMarkdownTables,
      resolveMarkdownTableMode: () => "preserve",
    });
    runtimeStore.setRuntime(runtime);
    const dispatcher = createFeishuReplyDispatcher({
      cfg: {
        channels: {
          feishu: {
            enabled: true,
            appId: "owned-tool-glyph",
            appSecret: "owned-fixture-secret",
            typingIndicator: false,
            renderMode: "card",
            streaming: { mode: "partial" },
          },
        },
      },
      agentId: "main",
      chatId: "oc_owned_chat",
      sendTarget: "oc_owned_chat",
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    });
    const publishedTexts = () =>
      requests
        .filter(({ path }) => path.endsWith("/elements/content/content"))
        .map(({ body }) => body.content);
    try {
      await dispatcher.dispatcherOptions.onReplyStart?.();
      await dispatcher.replyOptions.onItemEvent?.(
        projectAgentToolActivity({ name, toolCallId, phase: "start" }),
      );
      await vi.advanceTimersByTimeAsync(160);
      expect(publishedTexts().at(-1)).toContain(expected);
    } finally {
      await dispatcher.dispatcherOptions.onIdle?.();
      dispatcher.dispatcherOptions.onCleanup?.();
      if (previousRuntime) {
        runtimeStore.setRuntime(previousRuntime);
      } else {
        runtimeStore.clearRuntime();
      }
    }
  });
});

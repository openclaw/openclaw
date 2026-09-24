import { createServer, type Server } from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import {
  loadBundledEntryExportSync,
  type BundledEntryModuleLoadOptions,
} from "openclaw/plugin-sdk/channel-entry-contract";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { chunkMarkdownText } from "openclaw/plugin-sdk/reply-runtime";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin, OpenClawConfig, PluginRuntime, ReplyPayload } from "../api.js";
import { linePlugin } from "../channel-plugin-api.js";
import lineEntry from "../index.js";
import { recordLineQuoteToken } from "./quote-tokens.js";
import { getLineRuntime, setLineRuntime } from "./runtime.js";

const { mediaPreparation } = vi.hoisted(() => ({
  mediaPreparation: vi.fn<() => void | Promise<void>>(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    async resolvePinnedHostnameWithPolicy(
      ...args: Parameters<typeof actual.resolvePinnedHostnameWithPolicy>
    ) {
      const waiting = mediaPreparation();
      if (waiting) {
        await waiting;
      }
      return await actual.resolvePinnedHostnameWithPolicy(...args);
    },
  };
});

// Keep real entry registration without asking Jiti to rebuild the unrelated monitor graph.
const entryLoadOptions: BundledEntryModuleLoadOptions = {
  createLoaderForTest: (() => (specifier: string) => {
    if (/[\\/]channel-plugin-api\.[jt]s$/u.test(specifier)) {
      return { linePlugin };
    }
    if (/[\\/]runtime-api\.[jt]s$/u.test(specifier)) {
      return { setLineRuntime };
    }
    throw new Error(`Unexpected LINE entry module: ${specifier}`);
  }) as never,
};

const cfg = {
  channels: {
    line: {
      channelAccessToken: "line-handoff-test-token",
      channelSecret: "line-handoff-test-secret",
    },
  },
} satisfies OpenClawConfig;
const to = "U0123456789abcdef0123456789abcdef";
const mediaUrl = "https://93.184.216.34/picture.png";
const routes = ["message-text", "message-media", "payload", "outbound-media"] as const;
type Route = (typeof routes)[number];
type WireRequest = {
  to: string;
  messages: Array<{ type: string; text?: string; quoteToken?: string }>;
};

describe("registered LINE send handoff", () => {
  let server: Server;
  let plugin: ChannelPlugin;
  let controller: AbortController;
  let requests: WireRequest[];
  let onRequest: ((request: WireRequest) => number) | undefined;
  let onPrepared: (() => void) | undefined;
  let startedWhileActive: boolean[];

  const assertDirectAdapterHandoff = () => controller.signal.throwIfAborted();
  const retire = () => controller.abort(new Error("LINE handoff retired"));

  beforeEach(async () => {
    controller = new AbortController();
    requests = [];
    startedWhileActive = [];
    onRequest = undefined;
    onPrepared = undefined;
    mediaPreparation.mockReset();
    server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString()) as WireRequest;
        requests.push(body);
        const status = onRequest?.(body) ?? 200;
        response.writeHead(status, { "content-type": "application/json" });
        response.end(
          JSON.stringify(
            status === 200 || status === 409
              ? { sentMessages: body.messages.map((_, index) => ({ id: `sent-${index + 1}` })) }
              : { message: "LINE rejected the request" },
          ),
        );
      })().catch((error: unknown) => response.destroy(error instanceof Error ? error : undefined));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("LINE test server did not bind");
    }
    const nativeFetch = globalThis.fetch;
    const origin = `http://127.0.0.1:${address.port}`;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>((input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.origin !== "https://api.line.me") {
          throw new Error(`Unexpected LINE test request origin: ${url.origin}`);
        }
        startedWhileActive.push(!controller.signal.aborted);
        return nativeFetch(new URL(url.pathname, origin), init);
      }),
    );
    const runtime = {
      channel: {
        text: {
          chunkMarkdownText(text: string, limit: number) {
            const chunks = chunkMarkdownText(text, limit);
            onPrepared?.();
            return chunks;
          },
          resolveTextChunkLimit: () => 5000,
        },
      },
    } as unknown as PluginRuntime;
    const registered: ChannelPlugin[] = [];
    lineEntry.loadChannelPlugin(entryLoadOptions);
    loadBundledEntryExportSync(
      new URL("../index.js", import.meta.url).href,
      { specifier: "./runtime-api.js", exportName: "setLineRuntime" },
      entryLoadOptions,
    );
    lineEntry.register(
      createTestPluginApi({
        id: "line",
        config: cfg,
        runtime,
        registerChannel(registration) {
          registered.push("plugin" in registration ? registration.plugin : registration);
        },
      }),
    );
    plugin = expectDefined(
      registered.find((entry) => entry.id === "line"),
      "registered LINE",
    );
    expect(plugin).toBe(linePlugin);
    expect(getLineRuntime()).toBe(runtime);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
    vi.resetModules();
  });

  function send(route: Route, payload: ReplyPayload = { text: "hello" }) {
    const context = {
      cfg,
      to,
      text: payload.text ?? "",
      replyToId: payload.replyToId,
      assertDirectAdapterHandoff,
    };
    switch (route) {
      case "message-text":
        return expectDefined(plugin.message?.send?.text, "message text send")(context);
      case "message-media":
        return expectDefined(
          plugin.message?.send?.media,
          "message media send",
        )({
          ...context,
          mediaUrl,
        });
      case "outbound-media":
        return expectDefined(
          plugin.outbound?.sendMedia,
          "outbound media send",
        )({
          ...context,
          mediaUrl,
        });
      case "payload":
        return expectDefined(plugin.outbound?.sendPayload, "payload send")({ ...context, payload });
    }
    throw new Error("Unexpected LINE test route");
  }

  it.each(routes)("delivers an authorized %s and keeps the provider receipt", async (route) => {
    const result = await send(route);
    expect(result.messageId).toBe("sent-1");
    expect(result.receipt?.primaryPlatformMessageId).toBe("sent-1");
    expect(requests.length).toBeGreaterThan(0);
    expect(startedWhileActive.every(Boolean)).toBe(true);
    expect(requests.every((request) => request.to === to)).toBe(true);
  });

  it.each(routes)("refuses a retired %s before provider I/O", async (route) => {
    retire();
    await expect(send(route)).rejects.toThrow("LINE handoff retired");
    expect(requests).toEqual([]);
    expect(startedWhileActive).toEqual([]);
  });

  it("checks authority after real text preparation", async () => {
    onPrepared = retire;
    await expect(send("message-text")).rejects.toThrow("LINE handoff retired");
    expect(requests).toEqual([]);
  });

  it("stops media delivery when the caller retires during address preparation", async () => {
    const started = createDeferred<void>();
    const resume = createDeferred<void>();
    mediaPreparation.mockImplementationOnce(async () => {
      started.resolve();
      await resume.promise;
    });
    const sending = send("message-media", { text: "" });
    const rejected = expect(sending).rejects.toThrow("LINE handoff retired");
    try {
      await started.promise;
      retire();
    } finally {
      resume.resolve();
    }
    await rejected;
    expect(requests).toEqual([]);
    expect(startedWhileActive).toEqual([]);
  });

  it("rechecks the registered caller before retrying without a rejected quote", async () => {
    recordLineQuoteToken({
      accountId: "default",
      chatId: to,
      messageId: "source-message",
      quoteToken: "line-test-quote",
    });
    onRequest = () => {
      retire();
      return 400;
    };
    await expect(
      send("message-text", { text: "answer", replyToId: "source-message" }),
    ).rejects.toThrow("LINE handoff retired");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages[0]?.quoteToken).toBe("line-test-quote");
    expect(startedWhileActive).toEqual([true]);
  });

  it("stops later payload batches and retains the accepted batch observation", async () => {
    const accepted: string[] = [];
    await expect(
      expectDefined(
        plugin.outbound?.sendPayload,
        "payload send",
      )({
        cfg,
        to,
        text: "",
        payload: {
          channelData: { line: { quickReplies: ["OK"] } },
          mediaUrls: Array.from({ length: 6 }, () => mediaUrl),
        },
        assertDirectAdapterHandoff,
        onDeliveryResult: (result) => {
          accepted.push(result.messageId);
          retire();
        },
      }),
    ).rejects.toThrow("LINE handoff retired");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages).toHaveLength(5);
    expect(accepted).toEqual(["sent-1"]);
  });

  it("rechecks the registered caller before retrying a refused request", async () => {
    onRequest = () => {
      retire();
      return 503;
    };
    await expect(send("message-text")).rejects.toThrow("LINE handoff retired");
    expect(requests).toHaveLength(1);
    expect(startedWhileActive).toEqual([true]);
  });

  it("keeps an accepted response when the caller retires after dispatch", async () => {
    onRequest = () => {
      retire();
      return 200;
    };
    const result = await send("message-text");
    expect(result.messageId).toBe("sent-1");
    expect(result.receipt?.primaryPlatformMessageId).toBe("sent-1");
    expect(requests).toHaveLength(1);
  });
});

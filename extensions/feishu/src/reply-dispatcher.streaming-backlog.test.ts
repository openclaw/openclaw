import { randomUUID } from "node:crypto";
import { createServer } from "node:https";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  chunkMarkdownTextWithMode,
  chunkTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "openclaw/plugin-sdk/reply-chunking";
import { createPluginRuntimeStore, type PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { PROXY_FIXTURE_CERTIFICATE, PROXY_FIXTURE_KEY } from "openclaw/plugin-sdk/test-env";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { FeishuReplyDeliveryResultWithFinalization } from "./reply-delivery-result.js";

type WireRequest = { method: string; path: string; search: string; body: Record<string, unknown> };
type CreateDispatcher = typeof import("./reply-dispatcher.js").createFeishuReplyDispatcher;
let createFeishuReplyDispatcher: CreateDispatcher;

beforeAll(async () => {
  // Other Feishu suites replace these modules. Load this native transport fixture
  // after collection so it never inherits their session, SDK, or fetch doubles.
  vi.resetModules();
  ({ createFeishuReplyDispatcher } = await import("./reply-dispatcher.js"));
});

async function runStreamingTurn(queuedPreviews: string[], signal: AbortSignal) {
  const first = "The first accepted preview sentence.";
  const final = `${first} The complete final answer replaces pending previews.`;
  const requests: WireRequest[] = [];
  const serverErrors: unknown[] = [];
  const firstWriteStarted = createDeferred<void>();
  const releaseFirstWrite = createDeferred<void>();
  const accountId = `backlog-${randomUUID()}`;
  let heldFirstWrite = false;
  const server = createServer(
    { cert: PROXY_FIXTURE_CERTIFICATE, key: PROXY_FIXTURE_KEY },
    (request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<
          string,
          unknown
        >;
        const url = new URL(request.url ?? "/", "https://127.0.0.1");
        const path = url.pathname;
        const method = request.method ?? "GET";
        requests.push({ method, path, search: url.search, body });
        let result: Record<string, unknown>;
        if (method === "POST" && path.endsWith("/auth/v3/tenant_access_token/internal")) {
          result = { code: 0, tenant_access_token: "owned-fixture-token", expire: 7200 };
        } else if (method === "POST" && path === "/open-apis/cardkit/v1/cards") {
          result = { code: 0, data: { card_id: "owned-card" } };
        } else if (method === "POST" && path === "/open-apis/im/v1/messages") {
          result = { code: 0, data: { message_id: "om_owned_stream", chat_id: "oc_owned_chat" } };
        } else if (method === "PUT" && path.endsWith("/elements/content/content")) {
          if (!heldFirstWrite) {
            heldFirstWrite = true;
            firstWriteStarted.resolve();
            await releaseFirstWrite.promise;
          }
          result = { code: 0 };
        } else if (
          method === "PUT" &&
          (path.endsWith("/elements/content") || path.endsWith("/elements/note/content"))
        ) {
          result = { code: 0 };
        } else if (method === "PATCH" && path.endsWith("/settings")) {
          result = { code: 0 };
        } else {
          throw new Error(`Unexpected owned Feishu request: ${method} ${path}`);
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      })().catch((error: unknown) => {
        serverErrors.push(error);
        firstWriteStarted.reject(error);
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: 1, msg: "owned fixture rejected request" }));
      });
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Owned server did not receive a TCP port");
  }
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
    resolveMarkdownTableMode,
  });
  // Trust only the repository's public loopback fixture CA; retain normal TLS
  // certificate/hostname checks and restore the worker's trust store in finally.
  const previousCertificates = getCACertificates("default");
  const errors: string[] = [];
  let idle: Promise<void> | undefined;
  let cleanup: (() => void) | undefined;
  try {
    runtimeStore.setRuntime(runtime);
    setDefaultCACertificates([...previousCertificates, PROXY_FIXTURE_CERTIFICATE]);
    const dispatcher = createFeishuReplyDispatcher({
      cfg: {
        channels: {
          feishu: {
            enabled: true,
            appId: accountId,
            appSecret: "owned-fixture-secret",
            domain: `https://127.0.0.1:${address.port}`,
            httpTimeoutMs: 5000,
            typingIndicator: false,
            streaming: { mode: "partial" },
          },
        },
      },
      agentId: "main",
      chatId: "oc_owned_chat",
      sendTarget: "oc_owned_chat",
      accountId,
      runtime: {
        log: (message) => {
          // A startup/update transport rejection must fail the awaited barrier,
          // rather than leaving this fixture waiting for a request that cannot arrive.
          if (!heldFirstWrite && String(message).includes("Update failed:")) {
            firstWriteStarted.reject(new Error(String(message)));
          }
        },
        error: (message) => {
          errors.push(String(message));
          firstWriteStarted.reject(new Error(String(message)));
        },
        exit: (code) => {
          throw new Error(`Unexpected owned Feishu fixture exit: ${code}`);
        },
      },
    });
    cleanup = dispatcher.dispatcherOptions.onCleanup;
    expect(dispatcher.replyOptions.onPartialReply).toBeTypeOf("function");
    dispatcher.replyOptions.onPartialReply?.({ text: first });
    await withinTest(firstWriteStarted.promise, signal);
    // The first real CardKit HTTP response is still pending. Later snapshots
    // and the committed final enter the same callbacks used by inbound replies.
    for (const text of queuedPreviews) {
      dispatcher.replyOptions.onPartialReply?.({ text });
    }
    const delivered = (await withinTest(
      dispatcher.delivery.deliver(
        { text: queuedPreviews.length ? final : first },
        { kind: "final" },
      ),
      signal,
    )) as FeishuReplyDeliveryResultWithFinalization;
    idle = Promise.resolve(dispatcher.dispatcherOptions.onIdle?.());
    const settled = Promise.all([idle, delivered.finalization]);
    releaseFirstWrite.resolve();
    const [, accepted] = await withinTest(settled, signal);
    expect(serverErrors).toEqual([]);
    expect(errors).toEqual([]);
    expect(accepted).toMatchObject({
      visibleReplySent: true,
      content: queuedPreviews.length ? final : first,
      receipt: { primaryPlatformMessageId: "om_owned_stream" },
    });
    const messageSends = requests.filter((request) => request.path === "/open-apis/im/v1/messages");
    expect(messageSends).toHaveLength(1);
    expect(messageSends[0]?.search).toBe("?receive_id_type=chat_id");
    expect(messageSends[0]?.body).toMatchObject({
      receive_id: "oc_owned_chat",
      msg_type: "interactive",
      content: JSON.stringify({ type: "card", data: { card_id: "owned-card" } }),
    });
    const contentWrites = requests.filter(
      (request) => request.method === "PUT" && request.path.includes("/elements/content"),
    );
    const contents = contentWrites.map((request) =>
      typeof request.body.content === "string"
        ? request.body.content
        : (JSON.parse(String(request.body.element)) as { content: string }).content,
    );
    const close = requests.find((request) => request.path.endsWith("/settings"));
    expect(close).toBeDefined();
    expect(JSON.parse(String(close?.body.settings))).toMatchObject({
      config: {
        streaming_mode: false,
        summary: {
          content: queuedPreviews.length
            ? "The first accepted preview sentence. The comple..."
            : first,
        },
      },
    });
    expect(requests.at(-1)).toBe(close);
    return { contents, first, final };
  } finally {
    releaseFirstWrite.resolve();
    await idle?.catch(() => {});
    cleanup?.();
    if (previousRuntime) {
      runtimeStore.setRuntime(previousRuntime);
    } else {
      runtimeStore.clearRuntime();
    }
    setDefaultCACertificates(previousCertificates);
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

describe("Feishu streaming dispatcher with delayed native CardKit writes", () => {
  it("does not replay obsolete previews after the final reply is requested", async ({ signal }) => {
    const { contents, first, final } = await runStreamingTurn(
      [
        "The first accepted preview sentence. An obsolete intermediate continuation.",
        "The first accepted preview sentence. An obsolete intermediate continuation. Another obsolete continuation.",
      ],
      signal,
    );
    expect(contents).toEqual([first, final]);
  });

  it("preserves the accepted single-preview card and its final delivery receipt", async ({
    signal,
  }) => {
    const { contents, first } = await runStreamingTurn([], signal);
    expect(contents).toEqual([first]);
  });
});

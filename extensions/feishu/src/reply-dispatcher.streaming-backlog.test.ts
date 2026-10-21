import { randomUUID } from "node:crypto";
import { createServer } from "node:https";
import { buffer } from "node:stream/consumers";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { promisify } from "node:util";
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
import { beforeAll, expect, it, vi } from "vitest";
import type { FeishuReplyDeliveryResultWithFinalization } from "./reply-delivery-result.js";

type WireRequest = { method: string; path: string; search: string; body: Record<string, unknown> };
type CreateDispatcher = typeof import("./reply-dispatcher.js").createFeishuReplyDispatcher;
let createFeishuReplyDispatcher: CreateDispatcher;
const first = "The first accepted preview sentence.";
const final = `${first} The complete final answer replaces pending previews.`;

beforeAll(async () => {
  // Load after collection to avoid other suites' session, SDK, and fetch doubles.
  vi.resetModules();
  ({ createFeishuReplyDispatcher } = await import("./reply-dispatcher.js"));
});

async function runStreamingTurn(queuedPreviews: string[], signal: AbortSignal) {
  const finalText = queuedPreviews.length ? final : first;
  const requests: WireRequest[] = [];
  const errors: unknown[] = [];
  const firstWriteStarted = createDeferred<void>();
  const releaseFirstWrite = createDeferred<void>();
  const accountId = `backlog-${randomUUID()}`;
  let heldFirstWrite = false;
  const server = createServer(
    { cert: PROXY_FIXTURE_CERTIFICATE, key: PROXY_FIXTURE_KEY },
    (request, response) => {
      void (async () => {
        const body = JSON.parse((await buffer(request)).toString("utf8") || "{}") as Record<
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
        errors.push(error);
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
  // Trust the fixture CA without disabling TLS/hostname checks; restore it in finally.
  const previousCertificates = getCACertificates("default");
  let idle: Promise<void> | undefined;
  let cleanup: (() => void) | undefined;
  try {
    runtimeStore.setRuntime(runtime);
    setDefaultCACertificates([...previousCertificates, PROXY_FIXTURE_CERTIFICATE]);
    const feishu = {
      enabled: true,
      appId: accountId,
      appSecret: "owned-fixture-secret",
      domain: `https://127.0.0.1:${address.port}`,
      httpTimeoutMs: 5000,
      typingIndicator: false,
      streaming: { mode: "partial" as const },
    };
    const dispatcher = createFeishuReplyDispatcher({
      cfg: { channels: { feishu } },
      agentId: "main",
      chatId: "oc_owned_chat",
      sendTarget: "oc_owned_chat",
      accountId,
      runtime: {
        log: (message) => {
          // Fail the barrier if transport rejects before its first write.
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
    // Hold the first real write while queued snapshots and the final arrive.
    for (const text of queuedPreviews) {
      dispatcher.replyOptions.onPartialReply?.({ text });
    }
    const delivered = (await withinTest(
      dispatcher.delivery.deliver({ text: finalText }, { kind: "final" }),
      signal,
    )) as FeishuReplyDeliveryResultWithFinalization;
    idle = Promise.resolve(dispatcher.dispatcherOptions.onIdle?.());
    const settled = Promise.all([idle, delivered.finalization]);
    releaseFirstWrite.resolve();
    const [, accepted] = await withinTest(settled, signal);
    expect(errors).toEqual([]);
    expect(accepted).toMatchObject({
      visibleReplySent: true,
      content: finalText,
      receipt: { primaryPlatformMessageId: "om_owned_stream" },
    });
    const messageSends = requests.filter((request) => request.path === "/open-apis/im/v1/messages");
    expect(messageSends).toMatchObject([
      {
        search: "?receive_id_type=chat_id",
        body: {
          receive_id: "oc_owned_chat",
          msg_type: "interactive",
          content: JSON.stringify({ type: "card", data: { card_id: "owned-card" } }),
        },
      },
    ]);
    const contentWrites = requests.filter(
      (request) => request.method === "PUT" && request.path.includes("/elements/content"),
    );
    const contents = contentWrites.map((request) =>
      typeof request.body.content === "string"
        ? request.body.content
        : (JSON.parse(String(request.body.element)) as { content: string }).content,
    );
    const close = requests.find((request) => request.path.endsWith("/settings"));
    const summary = queuedPreviews.length
      ? "The first accepted preview sentence. The comple..."
      : first;
    expect(JSON.parse(String(close?.body.settings))).toMatchObject({
      config: {
        streaming_mode: false,
        summary: { content: summary },
      },
    });
    expect(requests.at(-1)).toBe(close);
    return contents;
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
    await promisify(server.close.bind(server))();
  }
}

it.for([
  {
    name: "replaces obsolete previews with the final reply",
    previews: [
      `${first} An obsolete intermediate continuation.`,
      `${first} An obsolete intermediate continuation. Another obsolete continuation.`,
    ],
    expected: [first, final],
  },
  { name: "preserves the single-preview card and receipt", previews: [], expected: [first] },
])("Feishu delayed native CardKit delivery $name", async ({ previews, expected }, { signal }) => {
  expect(await runStreamingTurn(previews, signal)).toEqual(expected);
});

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import {
  dispatchChannelInboundTurn,
  type ChannelInboundTurnPlan,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  createTestRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
  withPluginRuntimeRegistryScope,
} from "openclaw/plugin-sdk/channel-test-helpers";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import {
  createPluginRegistryOwner,
  createPluginRuntimeMock,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  chunkMarkdownTextWithMode,
  chunkTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "openclaw/plugin-sdk/reply-chunking";
import { finalizeInboundContext, type GetReplyOptions } from "openclaw/plugin-sdk/reply-runtime";
import { createPluginRuntimeStore, type PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { PROXY_FIXTURE_CERTIFICATE, PROXY_FIXTURE_KEY } from "openclaw/plugin-sdk/test-env";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import { loadWebMedia } from "openclaw/plugin-sdk/web-media";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import type { FeishuReplyDeliveryResultWithFinalization } from "./reply-delivery-result.js";

type WireRequest = { method: string; path: string; search: string; body: Record<string, unknown> };
type CreateDispatcher = typeof import("./reply-dispatcher.js").createFeishuReplyDispatcher;
type CreateBindings = typeof import("./thread-bindings.js").createFeishuThreadBindingManager;
type DeliveryResult = NonNullable<
  Parameters<NonNullable<ChannelInboundTurnPlan["delivery"]["onDelivered"]>>[2]
>;
type AdmittedScenario = {
  name: string;
  mode: "automatic" | "message_tool_only";
  sendPolicy: "allow" | "deny";
  silent: boolean;
  receipt: boolean;
  mediaKind?: "image" | "file";
  previewText?: string;
};
let createFeishuReplyDispatcher: CreateDispatcher;
let createFeishuThreadBindingManager: CreateBindings;
let feishuPlugin: typeof import("./channel.js").feishuPlugin;
let server: Server;
let domain: string;
let state: OpenClawTestState;
let registryOwner: ReturnType<typeof createPluginRegistryOwner>;
let requests: WireRequest[];
let serverErrors: unknown[];
let receiptSent = createDeferred();
let firstWriteStarted = createDeferred();
let releaseFirstWrite = createDeferred();
let holdFirstWrite: boolean;
let heldFirstWrite: boolean;
let previousCertificates: string[];
let imagePath: string;
let filePath: string;
const fixtureDispatchers: ReturnType<CreateDispatcher>[] = [];
const pngImage = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de",
  "hex",
);
const pdfFile = Buffer.from("%PDF-1.7\nSynthetic attachment-only reply\n%%EOF");

const runtimeStore = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "feishu",
  errorMessage: "Feishu runtime not initialized",
});
let previousRuntime: PluginRuntime | null;

function isContentWrite(request: WireRequest): boolean {
  return request.method === "PUT" && /\/elements\/content(?:\/content)?$/.test(request.path);
}

function contentWrites(): string[] {
  return requests
    .filter(isContentWrite)
    .map((request) =>
      typeof request.body.content === "string"
        ? request.body.content
        : (JSON.parse(String(request.body.element)) as { content: string }).content,
    );
}

function cardRequests(): WireRequest[] {
  return requests.filter((request) => request.path.startsWith("/open-apis/cardkit/"));
}

function messageRequests(): WireRequest[] {
  return requests.filter((request) => request.path === "/open-apis/im/v1/messages");
}

function parseRequestBody(body: Buffer, contentType: string | undefined): Record<string, unknown> {
  if (!contentType?.startsWith("multipart/form-data")) {
    return JSON.parse(body.toString("utf8") || "{}") as Record<string, unknown>;
  }
  const boundary = contentType
    .match(/boundary=(?:"([^"]+)"|([^;\s]+))/)
    ?.slice(1)
    .find(Boolean);
  if (!boundary) {
    throw new Error("Expected the SDK multipart boundary");
  }
  const fields: Record<string, unknown> = {};
  for (const part of body.toString("latin1").split(`--${boundary}`)) {
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      continue;
    }
    const headers = part.slice(0, headerEnd);
    const name = headers.match(/(?:^|;)\s*name="([^"]+)"/m)?.[1];
    if (!name) {
      continue;
    }
    const value = part.slice(headerEnd + 4).replace(/\r\n$/, "");
    fields[name] = /filename=/i.test(headers) ? Buffer.from(value, "latin1") : value;
  }
  return fields;
}

function createdCard(): { body: { elements: Array<{ element_id?: string; content?: string }> } } {
  const request = requests.find(
    ({ method, path }) => method === "POST" && path === "/open-apis/cardkit/v1/cards",
  );
  return JSON.parse(String(request?.body.data)) as {
    body: { elements: Array<{ element_id?: string; content?: string }> };
  };
}

function expectClosed(summary: string): void {
  const close = requests.find((request) => request.path.endsWith("/settings"));
  expect(close).toBeDefined();
  expect(JSON.parse(String(close?.body.settings))).toMatchObject({
    config: { streaming_mode: false, summary: { content: summary } },
  });
  expect(requests.at(-1)).toBe(close);
}

function normalizedWire(): string[] {
  return requests
    .filter((request) => !request.path.includes("/auth/"))
    .map((request) => {
      if (request.path === "/open-apis/cardkit/v1/cards") {
        const card = JSON.parse(String(request.body.data)) as {
          body: { elements: Array<{ element_id?: string; content?: string }> };
        };
        const content = card.body.elements.find(({ element_id }) => element_id === "content");
        return `card:create:${content?.content ?? ""}`;
      }
      if (request.path === "/open-apis/im/v1/messages") {
        return request.body.msg_type === "interactive"
          ? "message:create:card-reference"
          : `message:create:${String(request.body.msg_type)}`;
      }
      if (request.path === "/open-apis/im/v1/images") {
        return "image:upload";
      }
      if (request.path === "/open-apis/im/v1/files") {
        return "file:upload";
      }
      if (request.method === "DELETE") {
        return "message:delete";
      }
      if (isContentWrite(request)) {
        const content =
          typeof request.body.content === "string"
            ? request.body.content
            : (JSON.parse(String(request.body.element)) as { content: string }).content;
        return `content:${request.path.endsWith("/content/content") ? "update" : "replace"}:${content}`;
      }
      if (request.path.endsWith("/elements/note/content")) {
        return "note:update";
      }
      if (request.path.endsWith("/settings")) {
        const settings = JSON.parse(String(request.body.settings)) as {
          config: { streaming_mode: boolean; summary: { content: string } };
        };
        return `settings:streaming=${settings.config.streaming_mode}:summary=${settings.config.summary.content}`;
      }
      return request.method;
    });
}

function createNativeDispatcher(
  cfg: ClawdbotConfig,
  accountId: string,
  sessionKey?: string,
  messageCreateTimeMs = Date.now() - 7_000,
) {
  const errors: string[] = [];
  const dispatcher = createFeishuReplyDispatcher({
    cfg,
    agentId: "main",
    chatId: "oc_owned_chat",
    sendTarget: "oc_owned_chat",
    sessionKey,
    accountId,
    messageCreateTimeMs,
    runtime: {
      log: (message) => {
        if (!heldFirstWrite && String(message).includes("Update failed:")) {
          firstWriteStarted.reject(new Error(String(message)));
        }
      },
      error: (message) => {
        errors.push(String(message));
        const error = new Error(String(message));
        firstWriteStarted.reject(error);
        receiptSent.reject(error);
      },
      exit: (code) => {
        throw new Error(`Unexpected owned Feishu fixture exit: ${code}`);
      },
    },
  });
  fixtureDispatchers.push(dispatcher);
  return { dispatcher, errors };
}

function createConfig(accountId: string, sendPolicy: "allow" | "deny" = "allow"): ClawdbotConfig {
  return {
    // Keep discovery outside this fixture; the registered Feishu runtime is retained below.
    plugins: { enabled: false },
    agents: { defaults: { workspace: state.workspaceDir, silentReply: { group: "allow" } } },
    session: {
      store: resolveStorePath(undefined, { agentId: "main", env: state.env }),
      sendPolicy: { default: sendPolicy },
    },
    messages: { visibleReplies: "automatic" },
    channels: {
      feishu: {
        enabled: true,
        appId: accountId,
        appSecret: "owned-fixture-secret",
        domain,
        httpTimeoutMs: 5000,
        typingIndicator: false,
        streaming: { mode: "partial" },
      },
    },
  };
}

beforeAll(async () => {
  // Load native modules after collection so another suite's doubles cannot replace this boundary.
  vi.resetModules();
  ({ createFeishuReplyDispatcher } = await import("./reply-dispatcher.js"));
  ({ createFeishuThreadBindingManager } = await import("./thread-bindings.js"));
  ({ feishuPlugin } = await import("./channel.js"));
  state = await createOpenClawTestState({ label: "feishu-core-streaming" });
  filePath = await state.writeText("media/attachment.pdf", pdfFile.toString("utf8"));
  imagePath = state.statePath("media", "attachment.png");
  await writeFile(imagePath, pngImage);
  previousRuntime = runtimeStore.tryGetRuntime();
  const runtime = createPluginRuntimeMock();
  runtime.media.loadWebMedia = loadWebMedia;
  Object.assign(runtime.channel.text, {
    resolveTextChunkLimit,
    resolveChunkMode,
    chunkTextWithMode,
    chunkMarkdownTextWithMode,
    convertMarkdownTables,
    resolveMarkdownTableMode,
  });
  runtimeStore.setRuntime(runtime);
  const registry = createTestRegistry([
    { pluginId: "feishu", source: "test", plugin: feishuPlugin },
  ]);
  setActivePluginRegistry(registry);
  registryOwner = createPluginRegistryOwner(registry);
  initializeGlobalHookRunner(registry);

  previousCertificates = getCACertificates("default");
  setDefaultCACertificates([...previousCertificates, PROXY_FIXTURE_CERTIFICATE]);
  server = createServer(
    { cert: PROXY_FIXTURE_CERTIFICATE, key: PROXY_FIXTURE_KEY },
    (request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
        const body = parseRequestBody(Buffer.concat(chunks), request.headers["content-type"]);
        const url = new URL(request.url ?? "/", "https://127.0.0.1");
        const wire: WireRequest = {
          method: request.method ?? "GET",
          path: url.pathname,
          search: url.search,
          body,
        };
        requests.push(wire);
        let result: Record<string, unknown>;
        if (wire.method === "POST" && wire.path.endsWith("/auth/v3/tenant_access_token/internal")) {
          result = { code: 0, tenant_access_token: "owned-fixture-token", expire: 7200 };
        } else if (wire.method === "POST" && wire.path === "/open-apis/cardkit/v1/cards") {
          result = { code: 0, data: { card_id: "owned-card" } };
        } else if (wire.method === "POST" && wire.path === "/open-apis/im/v1/messages") {
          const type = body.msg_type;
          if (type !== "interactive" && type !== "image" && type !== "file") {
            throw new Error(`Unexpected native message type: ${String(type)}`);
          }
          result = {
            code: 0,
            data: {
              message_id: type === "interactive" ? "om_owned_stream" : `om_owned_${type}`,
              chat_id: "oc_owned_chat",
            },
          };
          if (type === "interactive") {
            receiptSent.resolve();
          }
        } else if (wire.method === "POST" && wire.path === "/open-apis/im/v1/images") {
          if (
            body.image_type !== "message" ||
            !Buffer.isBuffer(body.image) ||
            !body.image.equals(pngImage)
          ) {
            throw new Error("Native image upload did not contain the synthetic PNG bytes");
          }
          result = { code: 0, data: { image_key: "image_owned_attachment" } };
        } else if (wire.method === "POST" && wire.path === "/open-apis/im/v1/files") {
          if (
            body.file_type !== "pdf" ||
            body.file_name !== "attachment.pdf" ||
            !Buffer.isBuffer(body.file) ||
            !body.file.equals(pdfFile)
          ) {
            throw new Error("Native file upload did not contain the synthetic PDF bytes");
          }
          result = { code: 0, data: { file_key: "file_owned_attachment" } };
        } else if (isContentWrite(wire)) {
          if (holdFirstWrite && !heldFirstWrite) {
            heldFirstWrite = true;
            firstWriteStarted.resolve();
            await releaseFirstWrite.promise;
          }
          result = { code: 0 };
        } else if (
          (wire.method === "PUT" && wire.path.endsWith("/elements/note/content")) ||
          (wire.method === "PATCH" && wire.path.endsWith("/settings")) ||
          (wire.method === "DELETE" && wire.path === "/open-apis/im/v1/messages/om_owned_stream")
        ) {
          result = { code: 0 };
        } else {
          throw new Error(`Unexpected owned Feishu request: ${wire.method} ${wire.path}`);
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      })().catch((error: unknown) => {
        serverErrors.push(error);
        firstWriteStarted.reject(error);
        receiptSent.reject(error);
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
  domain = `https://127.0.0.1:${address.port}`;
});

beforeEach(() => {
  requests = [];
  serverErrors = [];
  receiptSent = createDeferred();
  firstWriteStarted = createDeferred();
  releaseFirstWrite = createDeferred();
  holdFirstWrite = false;
  heldFirstWrite = false;
  // A wire barrier may fail before a test waits for that particular request.
  void receiptSent.promise.catch(() => {});
  void firstWriteStarted.promise.catch(() => {});
});

afterEach(async () => {
  releaseFirstWrite.resolve();
  for (const dispatcher of fixtureDispatchers.splice(0)) {
    await dispatcher.dispatcherOptions.onIdle?.();
    dispatcher.dispatcherOptions.onCleanup?.();
  }
});

afterAll(async () => {
  resetGlobalHookRunner();
  await registryOwner.close();
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
  await state.cleanup();
});

async function runStreamingTurn(queuedPreviews: string[], signal: AbortSignal) {
  holdFirstWrite = true;
  const first = "The first accepted preview sentence.";
  const final = `${first} The complete final answer replaces pending previews.`;
  const accountId = `backlog-${randomUUID()}`;
  const { dispatcher, errors } = createNativeDispatcher(createConfig(accountId), accountId);
  let idle: Promise<void> | undefined;
  try {
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
    expect(messageRequests()).toHaveLength(1);
    expect(messageRequests()[0]?.search).toBe("?receive_id_type=chat_id");
    expect(messageRequests()[0]?.body).toMatchObject({
      receive_id: "oc_owned_chat",
      msg_type: "interactive",
      content: JSON.stringify({ type: "card", data: { card_id: "owned-card" } }),
    });
    expectClosed(
      queuedPreviews.length ? "The first accepted preview sentence. The comple..." : first,
    );
    return { contents: contentWrites(), first, final };
  } finally {
    releaseFirstWrite.resolve();
    await idle?.catch(() => {});
    dispatcher.dispatcherOptions.onCleanup?.();
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

describe("Feishu receipt through core admission and native HTTPS", () => {
  it.for<AdmittedScenario>([
    { name: "automatic", mode: "automatic", sendPolicy: "allow", silent: false, receipt: true },
    { name: "denied", mode: "automatic", sendPolicy: "deny", silent: false, receipt: false },
    {
      name: "message tool only",
      mode: "message_tool_only",
      sendPolicy: "allow",
      silent: false,
      receipt: false,
    },
    { name: "silent", mode: "automatic", sendPolicy: "allow", silent: true, receipt: true },
    {
      name: "image-only final",
      mode: "automatic",
      sendPolicy: "allow",
      silent: false,
      receipt: true,
      mediaKind: "image",
    },
    {
      name: "file-only final",
      mode: "automatic",
      sendPolicy: "allow",
      silent: false,
      receipt: true,
      mediaKind: "file",
    },
    {
      name: "accepted preview and image-only final",
      mode: "automatic",
      sendPolicy: "allow",
      silent: false,
      receipt: true,
      mediaKind: "image",
      previewText: "Accepted preview with attachment",
    },
  ])(
    "settles $name source delivery through the submitted callback path",
    async (scenario, { signal }) => {
      const accountId = `admission-${randomUUID()}`;
      const sessionKey = `agent:main:feishu:group:${accountId}`;
      const cfg = createConfig(accountId, scenario.sendPolicy);
      const bindings = createFeishuThreadBindingManager({ cfg, accountId });
      // Cover the event's seconds form on an existing case; other cases use milliseconds.
      const messageTime = scenario.silent ? (Date.now() - 7_000) / 1_000 : Date.now() - 7_000;
      const { dispatcher, errors } = createNativeDispatcher(
        cfg,
        accountId,
        sessionKey,
        messageTime,
      );
      const delivered: DeliveryResult[] = [];
      const ownership = vi.fn(() => "reply-dispatch");
      let sawReceiptBeforeOutput = false;
      const pending = withPluginRuntimeRegistryScope(registryOwner.registry, () =>
        dispatchChannelInboundTurn({
          cfg,
          channel: "feishu",
          accountId,
          route: { agentId: "main", sessionKey },
          ctxPayload: finalizeInboundContext({
            Body: "Synthetic incoming request",
            BodyForAgent: "Synthetic incoming request",
            ChatType: "group",
            From: "ou_fixture",
            To: "oc_owned_chat",
            SenderId: "ou_fixture",
            SessionKey: sessionKey,
            MessageSid: `inbound-${accountId}`,
            Provider: "feishu",
            Surface: "feishu",
            AccountId: accountId,
            WasMentioned: false,
          }),
          dispatcherOptions: dispatcher.dispatcherOptions,
          delivery: {
            ...dispatcher.delivery,
            onDelivered: async (...args) => {
              await dispatcher.delivery.onDelivered?.(...args);
              if (args[2]) {
                delivered.push(args[2]);
              }
            },
          },
          replyOptions: {
            ...dispatcher.replyOptions,
            abortSignal: signal,
            sourceReplyDeliveryMode: scenario.mode,
            onPreparedAgentRunStart: ownership,
          },
          replyResolver: async (_ctx, options?: GetReplyOptions) => {
            expect(cardRequests()).toHaveLength(0);
            expect(options?.sourceReplyDeliveryMode).toBe(scenario.mode);
            options?.onModelSelected?.({
              provider: "synthetic",
              model: "fixture-model",
              thinkLevel: "off",
            });
            expect(
              options?.onPreparedAgentRunStart?.({
                runId: `run-${accountId}`,
                transcriptStart: null,
              }),
            ).toBe("reply-dispatch");
            // Resolver-facing previews retain the same policy as the admitted bridge.
            await options?.onPreviewStart?.();
            if (scenario.receipt) {
              await withinTest(receiptSent.promise, signal);
              sawReceiptBeforeOutput = true;
              expect(createdCard().body.elements).toContainEqual({
                tag: "markdown",
                element_id: "content",
                content: "Received, processing…",
              });
              expect(contentWrites()).toEqual([]);
              const initialNote = createdCard().body.elements.find(
                ({ element_id }) => element_id === "note",
              )?.content;
              expect(initialNote).toMatch(/Model: fixture-model \| Provider: synthetic ⏱ \d+\.\ds/);
              if (scenario.name === "automatic") {
                // Model selection may change after the early receipt, as with a fallback candidate.
                options?.onModelSelected?.({
                  provider: "synthetic",
                  model: "selected-fixture-model",
                  thinkLevel: "off",
                });
              }
            } else {
              expect(cardRequests()).toHaveLength(0);
              expect(messageRequests()).toHaveLength(0);
            }
            if (scenario.mediaKind) {
              if (scenario.previewText) {
                await options?.onPartialReply?.({ text: scenario.previewText });
              }
              return { mediaUrl: scenario.mediaKind === "image" ? imagePath : filePath };
            }
            if (!scenario.silent) {
              await options?.onPartialReply?.({ text: "Final answer" });
            }
            return { text: scenario.silent ? "NO_REPLY" : "Final answer" };
          },
        }),
      );
      let result: Awaited<typeof pending>;
      try {
        result = await withinTest(pending, signal);
      } finally {
        await pending.catch(() => {});
        // Core starts idle observers asynchronously; join the channel's retained cleanup owner.
        await dispatcher.dispatcherOptions.onIdle?.();
        bindings.stop();
      }

      expect(result.dispatched).toBe(true);
      if (!result.dispatched) {
        throw new Error("Expected the synthetic Feishu turn to dispatch");
      }
      expect(ownership).toHaveBeenCalledOnce();
      expect(result.dispatchResult.sendPolicyDenied ?? false).toBe(scenario.sendPolicy === "deny");
      expect(result.dispatchResult.sourceReplyDeliveryMode ?? "automatic").toBe(scenario.mode);
      console.log(
        `[feishu submitted-path proof] ${scenario.name}: ${JSON.stringify(normalizedWire())}`,
      );
      expect(errors).toEqual([]);
      expect(serverErrors).toEqual([]);
      expect(sawReceiptBeforeOutput).toBe(scenario.receipt);
      if (!scenario.receipt) {
        expect(cardRequests()).toHaveLength(0);
        expect(messageRequests()).toHaveLength(0);
        expect(result.dispatchResult.settledReceipt?.anyVisibleDelivered).toBe(false);
        return;
      }
      if (scenario.mediaKind) {
        const attachmentId = `om_owned_${scenario.mediaKind}`;
        const attachment = messageRequests().find(
          ({ body }) => body.msg_type === scenario.mediaKind,
        );
        expect(attachment?.body).toMatchObject({
          receive_id: "oc_owned_chat",
          msg_type: scenario.mediaKind,
          content: JSON.stringify(
            scenario.mediaKind === "image"
              ? { image_key: "image_owned_attachment" }
              : { file_key: "file_owned_attachment" },
          ),
        });
        expect(result.dispatchResult.settledReceipt?.anyVisibleDelivered).toBe(true);
        expect(result.dispatchResult.settledReceipt?.counts.final.delivered).toBe(1);
        expect(delivered).toContainEqual(
          expect.objectContaining({
            visibleReplySent: true,
            receipt: expect.objectContaining({ primaryPlatformMessageId: attachmentId }),
          }),
        );
        expect(messageRequests()).toHaveLength(2);
        if (scenario.previewText) {
          expect(requests.filter(({ method }) => method === "DELETE")).toEqual([]);
          expect(contentWrites()).toEqual([scenario.previewText]);
          expectClosed(scenario.previewText);
        } else {
          expect(requests.filter(({ method }) => method === "DELETE")).toMatchObject([
            { path: "/open-apis/im/v1/messages/om_owned_stream" },
          ]);
          expect(contentWrites()).toEqual([]);
          expect(requests.filter(({ path }) => path.endsWith("/settings"))).toEqual([]);
        }
        return;
      }
      expect(messageRequests()).toHaveLength(1);
      if (scenario.silent) {
        expect(contentWrites()).toEqual([]);
        expect(requests.filter(({ method }) => method === "DELETE")).toMatchObject([
          { path: "/open-apis/im/v1/messages/om_owned_stream" },
        ]);
        expect(result.dispatchResult.deliberateSilentTerminalReply).toBe(true);
        expect(result.dispatchResult.settledReceipt?.anyVisibleDelivered).toBe(false);
        return;
      }
      expect(contentWrites()).toEqual(["Final answer"]);
      expectClosed("Final answer");
      expect(
        requests.findLast(({ path }) => path.endsWith("/elements/note/content"))?.body.content,
      ).toMatch(/Model: selected-fixture-model \| Provider: synthetic ⏱ \d+\.\ds/);
      expect(result.dispatchResult.settledReceipt?.anyVisibleDelivered).toBe(true);
      expect(result.dispatchResult.settledReceipt?.counts.final.delivered).toBe(1);
      expect(delivered).toContainEqual(
        expect.objectContaining({
          visibleReplySent: true,
          content: "Final answer",
          receipt: expect.objectContaining({ primaryPlatformMessageId: "om_owned_stream" }),
        }),
      );
    },
  );
});

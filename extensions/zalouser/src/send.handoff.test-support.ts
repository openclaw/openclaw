import { AsyncResource } from "node:async_hooks";
import { createCipheriv, createDecipheriv } from "node:crypto";
import { createRequire } from "node:module";
import type {
  ChannelMessageSendTextContext,
  MessageReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/plugin-test-runtime";
import { vi } from "vitest";
import { zalouserPlugin } from "./channel.js";
import { setZalouserRuntime } from "./runtime.js";
import {
  clearStoredZaloCredentials,
  loadStoredZaloCredentials,
  refreshStoredZaloCredentials,
  type StoredZaloCredentials,
} from "./session-state.js";
import { logoutZaloProfile } from "./zalo-js.js";
import type { API } from "./zca-client.js";

type SdkOptions = { logging?: boolean; selfListen?: boolean; polyfill?: typeof fetch };
type SdkZalo = { options: SdkOptions; login(credentials: unknown): Promise<API> };
type CookieStore = {
  findCookies(
    domain: string | null,
    path: string | null,
    allowSpecialUseDomain: boolean,
    callback: (error: Error | null, cookies?: unknown[]) => void,
  ): void;
};
type CookieJar = {
  setCookieSync(value: string, url: string): unknown;
  toJSON(): { cookies: unknown[] };
};
type UploadCallback = (data: { fileId: string; fileUrl: string }) => unknown;

const require = createRequire(import.meta.url);
// The plugin's ambient declaration omits these existing SDK fixture constructors.
const sdk = require("zca-js") as {
  Zalo: { new (options?: SdkOptions): SdkZalo; prototype: SdkZalo };
  API: new (
    ctx: ReturnType<typeof createSdkContext>,
    services: Record<string, string[]>,
    wsUrls: string[],
  ) => API;
};
const sdkRequire = createRequire(require.resolve("zca-js"));
const { CookieJar, MemoryCookieStore } = sdkRequire("tough-cookie") as {
  CookieJar: new (store: CookieStore) => CookieJar;
  MemoryCookieStore: new () => CookieStore;
};
const secretKey = Buffer.alloc(16, 1);
export const serviceUrl = "https://zalo.test";
export const imageUrl = "https://media.test/photo.png";
const voiceUrl = "https://zalo.test/voice.aac";

type Gate = {
  entered: ReturnType<typeof createDeferred<void>>;
  release: ReturnType<typeof createDeferred<void>>;
};
export type SendRoute = "message.text" | "message.media" | "sendText" | "sendMedia" | "sendPayload";
type SendInput = Pick<
  ChannelMessageSendTextContext,
  "signal" | "assertDirectAdapterHandoff" | "onPlatformSendDispatch"
> & {
  text?: string;
  to?: string;
  mediaUrl?: string;
  onDeliveryResult?: (result: {
    messageId?: string;
    receipt?: MessageReceipt;
  }) => Promise<void> | void;
};
export type SentRequest = { method: string; path: string; params: Record<string, unknown> };

function required<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new Error("Expected registered Zalouser sender");
  }
  return value;
}

export function encryptResponse(data: unknown): Response {
  const cipher = createCipheriv("aes-128-cbc", secretKey, Buffer.alloc(16));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify({ error_code: 0, data }), "utf8"),
    cipher.final(),
  ]).toString("base64");
  return Response.json({ error_code: 0, data: encrypted });
}

function readRequest(input: Parameters<typeof fetch>[0], init?: RequestInit): SentRequest {
  const url = new URL(input instanceof Request ? input.url : input);
  const encrypted =
    (init?.body instanceof URLSearchParams ? init.body.get("params") : null) ??
    url.searchParams.get("params");
  let params: Record<string, unknown> = {};
  if (encrypted) {
    const decipher = createDecipheriv("aes-128-cbc", secretKey, Buffer.alloc(16));
    params = JSON.parse(
      Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString(
        "utf8",
      ),
    ) as Record<string, unknown>;
  }
  return { method: init?.method ?? "GET", path: url.pathname, params };
}

function createSdkContext(
  cookie: CookieJar,
  uploads: Map<string, UploadCallback>,
  fetch: typeof globalThis.fetch,
  options: SdkOptions,
) {
  return {
    API_TYPE: 30,
    API_VERSION: 671,
    uid: "100",
    imei: "synthetic-imei",
    userAgent: "synthetic-user-agent",
    language: "en",
    secretKey: secretKey.toString("base64"),
    cookie,
    options: { selfListen: false, checkUpdate: false, logging: false, polyfill: fetch, ...options },
    uploadCallbacks: uploads,
    settings: {
      features: {
        sharefile: {
          max_file: 10,
          max_size_share_file_v3: 10,
          chunk_size_file: 1024,
          restricted_ext_file: [],
        },
        socket: { retries: {} },
      },
    },
  };
}

export class SendHarness {
  readonly profile = "handoff-test";
  readonly cfg: OpenClawConfig = { channels: { zalouser: { profile: this.profile } } };
  readonly requests: SentRequest[] = [];
  readonly cookieWaits: Gate[] = [];
  private readonly gates: Gate[] = [];
  private readonly pending: Promise<unknown>[] = [];
  private readonly uploadEvents = new AsyncResource("zalouser-test-upload");
  response?: (request: SentRequest) => Promise<Response> | Response;
  uploadWait?: Gate;
  api?: API;
  private nextMessage = 0;

  gate(): Gate {
    const gate = { entered: createDeferred<void>(), release: createDeferred<void>() };
    this.gates.push(gate);
    return gate;
  }

  holdCookie(): Gate {
    const gate = this.gate();
    this.cookieWaits.push(gate);
    return gate;
  }

  track<T>(promise: Promise<T>): Promise<T> {
    this.pending.push(promise);
    void promise.catch(() => {});
    return promise;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const request = readRequest(input, init);
    this.requests.push(request);
    return this.response ? this.response(request) : this.respond(request);
  };

  respond(request: SentRequest): Response {
    if (request.method === "HEAD") {
      return new Response(null, { headers: { "content-length": "8" } });
    }
    if (request.path.endsWith("/photo_original/upload")) {
      return encryptResponse({
        photoId: "photo-1",
        normalUrl: imageUrl,
        hdUrl: imageUrl,
        thumbUrl: imageUrl,
        finished: 1,
        chunkId: 1,
        clientFileId: "file-1",
      });
    }
    if (request.path.endsWith("/asyncfile/upload")) {
      return encryptResponse({ fileId: "file-1", clientFileId: "file-1" });
    }
    if (/\/(sms|sendmsg|photo_original\/send|asyncfile\/msg|forward)$/.test(request.path)) {
      return encryptResponse({ msgId: `message-${++this.nextMessage}` });
    }
    throw new Error(`Unexpected SDK request: ${request.method} ${request.path}`);
  }

  createApi(options: SdkOptions): API {
    const store = new MemoryCookieStore();
    const cookie = new CookieJar(store);
    cookie.setCookieSync("zpsid=synthetic; Domain=zalo.test; Path=/", serviceUrl);
    // API construction binds unrelated endpoint families too; every service uses synthetic responses.
    const services = new Proxy<Record<string, string[]>>({}, { get: () => [serviceUrl] });
    const uploads = new Map<string, UploadCallback>();
    const setUpload = uploads.set.bind(uploads);
    uploads.set = (fileId, callback) => {
      setUpload(fileId, callback);
      // Model a socket completion outside the sending caller without opening a socket or expiry timer.
      void this.track(
        this.uploadEvents.runInAsyncScope(async () => {
          if (this.uploadWait) {
            this.uploadWait.entered.resolve();
            await this.uploadWait.release.promise;
          }
          await callback({ fileId, fileUrl: voiceUrl });
          uploads.delete(fileId);
        }),
      );
      return uploads;
    };
    const api = new sdk.API(createSdkContext(cookie, uploads, this.fetch, options), services, [
      "wss://zalo.test/events",
    ]);
    const findCookies = store.findCookies.bind(store);
    vi.spyOn(store, "findCookies").mockImplementation((...args) => {
      const wait = this.cookieWaits.shift();
      if (!wait) {
        return findCookies(...args);
      }
      wait.entered.resolve();
      void wait.release.promise.then(() => findCookies(...args));
    });
    this.api = api;
    return api;
  }

  send(route: SendRoute, input: SendInput = {}) {
    const ctx = { cfg: this.cfg, to: "user:200", text: "hello", ...input };
    switch (route) {
      case "message.text":
        return this.track(required(zalouserPlugin.message?.send?.text)(ctx));
      case "message.media":
        return this.track(
          required(zalouserPlugin.message?.send?.media)({
            ...ctx,
            mediaUrl: input.mediaUrl ?? imageUrl,
          }),
        );
      case "sendText":
        return this.track(required(zalouserPlugin.outbound?.sendText)(ctx));
      case "sendMedia":
        return this.track(
          required(zalouserPlugin.outbound?.sendMedia)({
            ...ctx,
            mediaUrl: input.mediaUrl ?? imageUrl,
          }),
        );
      case "sendPayload":
        return this.track(
          required(zalouserPlugin.outbound?.sendPayload)({
            ...ctx,
            payload: { text: ctx.text, ...(input.mediaUrl ? { mediaUrl: input.mediaUrl } : {}) },
          }),
        );
      default: {
        const unexpectedRoute: never = route;
        throw new Error("Unsupported send route", { cause: unexpectedRoute });
      }
    }
  }

  async close() {
    for (const gate of this.gates) {
      gate.release.resolve();
    }
    await Promise.allSettled(this.pending);
    await logoutZaloProfile(this.profile);
    this.uploadEvents.emitDestroy();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
}

export function createSendHarness(options: { mediaFixture?: boolean } = {}): SendHarness {
  const harness = new SendHarness();
  const runtime = createPluginRuntimeMock();
  vi.mocked(runtime.channel.text.resolveChunkMode).mockReturnValue("length");
  vi.mocked(runtime.channel.text.resolveTextChunkLimit).mockReturnValue(2000);
  setZalouserRuntime(runtime);
  vi.stubGlobal("fetch", harness.fetch);
  vi.spyOn(sdk.Zalo.prototype, "login").mockImplementation(async function (this: SdkZalo) {
    return harness.createApi(this.options);
  });
  const stored: StoredZaloCredentials = {
    profile: harness.profile,
    imei: "synthetic-imei",
    cookie: [{ key: "zpsid", value: "synthetic", domain: "zalo.test", path: "/" }],
    userAgent: "synthetic-user-agent",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  vi.mocked(loadStoredZaloCredentials).mockResolvedValue(stored);
  vi.mocked(refreshStoredZaloCredentials).mockImplementation(async (_profile, credentials) => ({
    ...stored,
    ...credentials,
  }));
  vi.mocked(clearStoredZaloCredentials).mockResolvedValue(true);
  if (options.mediaFixture !== false) {
    vi.mocked(loadOutboundMediaFromUrl).mockResolvedValue({
      buffer: Buffer.from("fixture"),
      kind: "image",
      contentType: "image/png",
      fileName: "photo.png",
    });
  }
  return harness;
}

export function useAudioFixture() {
  vi.mocked(loadOutboundMediaFromUrl).mockResolvedValue({
    buffer: Buffer.from("fixture-audio"),
    kind: "audio",
    contentType: "audio/aac",
    fileName: "voice.aac",
  });
}

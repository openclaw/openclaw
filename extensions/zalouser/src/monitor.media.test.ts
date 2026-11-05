import fs from "node:fs/promises";
import path from "node:path";
import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { saveMediaBuffer, saveRemoteMedia } from "openclaw/plugin-sdk/media-runtime";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import "./monitor.send.test-mocks.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { startZaloListenerMock } from "./zalo-js.test-mocks.js";
import {
  createRawZalouserMessage,
  observeZalouserIngressVerdict,
  withZalouserIngressTestQueue,
} from "./ingress.test-support.js";
import { monitorZalouserProvider } from "./monitor.js";
import { setZalouserRuntime } from "./runtime.js";
import { createDefaultResolvedZalouserAccount, createZalouserRuntimeEnv } from "./test-helpers.js";
import { normalizeZaloInboundMessage } from "./zalo-js.js";

beforeAll(async () => {
  const actual = await vi.importActual<typeof import("./zalo-js.js")>("./zalo-js.js");
  vi.mocked(normalizeZaloInboundMessage).mockImplementation(actual.normalizeZaloInboundMessage);
});
beforeEach(() => {
  startZaloListenerMock.mockReset();
});

type Core = ReturnType<typeof createPluginRuntimeMock>;
type Queue = NonNullable<Parameters<typeof monitorZalouserProvider>[0]["ingressQueue"]>;

function createRuntime() {
  const core = createPluginRuntimeMock();
  core.channel.inbound.buildContext = buildChannelInboundEventContext;
  const dispatch = vi
    .spyOn(core.channel.inbound, "dispatch")
    .mockImplementation(async ({ ctxPayload }) => ({
      admission: { kind: "dispatch" },
      dispatched: true,
      ctxPayload,
      routeSessionKey: "agent:main:zalouser:direct:321",
      dispatchResult: { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } },
    }));
  return { core, dispatch };
}

async function receive(
  core: Core,
  ingressQueue: Queue,
  options: {
    msgType?: string;
    title?: string;
    href?: string;
    isGroup?: boolean;
    allowed?: boolean;
    pairing?: boolean;
    abort?: AbortController;
    cancelled?: boolean;
  } = {},
) {
  setZalouserRuntime(core);
  const abort = options.abort ?? new AbortController();
  const listener =
    Promise.withResolvers<Parameters<typeof import("./zalo-js.js").startZaloListener>[0]>();
  startZaloListenerMock.mockImplementationOnce(async (params) => {
    listener.resolve(params);
    return { stop: vi.fn() };
  });
  const account = createDefaultResolvedZalouserAccount({
    mediaMaxBytes: 64,
    config: {
      dmPolicy: options.pairing ? "pairing" : "allowlist",
      allowFrom: options.pairing || options.allowed === false ? [] : ["321"],
      groupPolicy: "open",
      groups: { "*": { requireMention: true } },
    },
  });
  const run = monitorZalouserProvider({
    account,
    config: { channels: { zalouser: account.config } },
    ingressQueue,
    runtime: createZalouserRuntimeEnv(),
    abortSignal: abort.signal,
  });
  try {
    const started = await Promise.race([
      listener.promise,
      run.then(() => {
        throw new Error("monitor exited before listening");
      }),
    ]);
    const raw = createRawZalouserMessage({
      senderId: "321",
      msgId: "media",
      isGroup: options.isGroup,
    });
    raw.data.msgType = options.msgType ?? "share.file";
    raw.data.content = {
      title: options.title ?? "report.txt",
      href: options.href ?? "https://file-stal-1.dlfl.vn/opaque",
    };
    const terminal = options.cancelled
      ? undefined
      : observeZalouserIngressVerdict(ingressQueue, "media", "completed");
    await started.onMessage(raw);
    await (terminal ?? run);
  } finally {
    abort.abort();
    await run;
  }
}

it.each([
  { msgType: "share.file", kind: "document", mime: "text/plain", title: "report.txt" },
  { msgType: "chat.photo", kind: "image", mime: "image/png", title: "" },
  { msgType: "chat.video.msg", kind: "video", mime: "video/mp4", title: "" },
])("delivers a received $kind as readable agent media", async ({ msgType, kind, mime, title }) => {
  await withZalouserIngressTestQueue(async (ingressQueue) => {
    const { core, dispatch } = createRuntime();
    const bytes = Buffer.from("synthetic received attachment");
    core.channel.media.saveRemoteMedia = (options) =>
      saveRemoteMedia({
        ...options,
        lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
        fetchImpl: async () => new Response(bytes, { headers: { "content-type": mime } }),
      });
    await receive(core, ingressQueue, { msgType, title });
    const media = dispatch.mock.calls[0]?.[0].ctxPayload.media?.[0];
    expect(media).toMatchObject({ kind, contentType: mime, sizeBytes: bytes.length });
    if (!media?.path) {
      throw new Error("missing agent media path");
    }
    expect(await fs.readFile(media.path)).toEqual(bytes);
    if (title) {
      expect(media.fileName).toBe(title);
    }
  });
});

it.each(["allowed", "revoked", "cancelled"])("settles staged media when %s", async (outcome) => {
  await withZalouserIngressTestQueue(async (ingressQueue) => {
    const { core, dispatch } = createRuntime();
    const abort = new AbortController();
    let allowFrom = ["321"];
    vi.mocked(core.channel.pairing.readAllowFromStore).mockImplementation(async () => allowFrom);
    const neighbor = await saveMediaBuffer(Buffer.from("keep"), "text/plain");
    let stagedPath = "";
    core.channel.media.deleteMediaBuffer = async (id) => {
      await fs.unlink(path.join(path.dirname(neighbor.path), id));
    };
    core.channel.media.saveRemoteMedia = async () => {
      const saved = await saveMediaBuffer(Buffer.from("received"), "text/plain");
      stagedPath = saved.path;
      if (outcome === "revoked") {
        allowFrom = [];
      }
      if (outcome === "cancelled") {
        abort.abort();
      }
      return saved;
    };
    await receive(core, ingressQueue, { pairing: true, abort, cancelled: outcome === "cancelled" });
    expect(stagedPath).not.toBe("");
    expect(dispatch).toHaveBeenCalledTimes(outcome === "allowed" ? 1 : 0);
    expect(await fs.readFile(neighbor.path, "utf8")).toBe("keep");
    if (outcome === "allowed") {
      expect(await fs.readFile(stagedPath, "utf8")).toBe("received");
    } else {
      await expect(fs.stat(stagedPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});

it.each([
  { name: "unlisted sender", allowed: false },
  { name: "unmentioned group", isGroup: true },
  { name: "link preview", msgType: "chat.recommended" },
  { name: "plain text", msgType: "webchat" },
])("does not download $name", async (options) => {
  await withZalouserIngressTestQueue(async (ingressQueue) => {
    const { core, dispatch } = createRuntime();
    const download = vi.spyOn(core.channel.media, "saveRemoteMedia");
    await receive(core, ingressQueue, options);
    expect(download).not.toHaveBeenCalled();
    if (options.allowed === false || options.isGroup) {
      expect(dispatch).not.toHaveBeenCalled();
    }
  });
});

it.each([
  { name: "HTTP", href: "http://file-stal-1.dlfl.vn/file" },
  { name: "non-CDN host", href: "https://example.com/file" },
  { name: "private address", address: "127.0.0.1" },
  { name: "redirect outside CDN", redirect: "https://example.com/file" },
  { name: "HTTPS downgrade", redirect: "http://file-stal-1.dlfl.vn/file" },
  { name: "oversize response", bytes: 65 },
])("reports unavailable media for $name", async (options) => {
  await withZalouserIngressTestQueue(async (ingressQueue) => {
    const { core, dispatch } = createRuntime();
    core.channel.media.saveRemoteMedia = (params) =>
      saveRemoteMedia({
        ...params,
        lookupFn: async () => [{ address: options.address ?? "93.184.216.34", family: 4 }],
        fetchImpl: async () =>
          options.redirect
            ? new Response(null, { status: 302, headers: { location: options.redirect } })
            : new Response(Buffer.alloc(options.bytes ?? 1), {
                headers: { "content-type": "text/plain" },
              }),
      });
    await receive(core, ingressQueue, options);
    const context = dispatch.mock.calls[0]?.[0].ctxPayload;
    expect(context?.media).toEqual([]);
    expect(context?.BodyForAgent).toContain("[zalouser document attachment unavailable]");
  });
});

import fs from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import type { HostedOutboundMediaChunkRecord } from "openclaw/plugin-sdk/outbound-media";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import type { loadWebMedia as loadWebMediaType } from "openclaw/plugin-sdk/web-media";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareSynologyHostedMedia,
  tryHandleSynologyHostedMediaRequest,
} from "./outbound-media.js";
import { setSynologyRuntime } from "./runtime.js";
import { makeAccount, makeReq, makeRes } from "./test-http-utils.js";
import type { ResolvedSynologyChatAccount } from "./types.js";

const loadWebMediaMock = vi.hoisted(() => vi.fn<typeof loadWebMediaType>());

vi.mock("openclaw/plugin-sdk/web-media", () => ({
  loadWebMedia: loadWebMediaMock,
}));

const testStateDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    cleanup();
  });
});
// Each test gets clean SQLite state; reopen cases retain it within that test.
const testStateDir = testStateDirs.make(
  "openclaw-synology-media-",
  resolvePreferredOpenClawTmpDir(),
);
const testStateEnv: NodeJS.ProcessEnv = {
  ...process.env,
  OPENCLAW_STATE_DIR: testStateDir,
};

function createAccount(overrides: Partial<ResolvedSynologyChatAccount> = {}) {
  return makeAccount({
    webhookUrl: "https://gateway.example.com/public/synology?proxy-token=keep",
    webhookPath: "/internal/synology",
    webhookPathSource: "explicit" as const,
    ...overrides,
  });
}

function installRuntime() {
  const openedStores: PluginStateKeyedStore<unknown>[] = [];
  const openKeyedStore = (options: OpenKeyedStoreOptions) => {
    const store = createPluginStateKeyedStoreForTests("synology-chat", {
      ...options,
      env: testStateEnv,
    });
    openedStores.push(store);
    return store;
  };
  setSynologyRuntime({ state: { openKeyedStore } } as unknown as PluginRuntime);
  return openedStores;
}

function trackChunkReads<T>(store: PluginStateKeyedStore<T>) {
  const lookup = vi.spyOn(store, "lookup");
  const lookupMany = store.lookupMany ? vi.spyOn(store, "lookupMany") : undefined;
  return () => lookup.mock.calls.length + (lookupMany?.mock.calls.length ?? 0);
}

function internalCapabilityUrl(publicUrl: string, pathName = "/internal/synology"): string {
  return `${pathName}${new URL(publicUrl).search}`;
}

function withWrongToken(url: string) {
  const parsed = new URL(url, "http://localhost");
  const key = expectDefined(
    [...parsed.searchParams.keys()].find((param) =>
      param.startsWith("__openclaw_synology_media_token_"),
    ),
    "capability token",
  );
  parsed.searchParams.set(key, "wrong");
  return `${parsed.pathname}${parsed.search}`;
}

function mockMedia(
  buffer: Buffer,
  contentType = "application/octet-stream",
  fileName = "document.bin",
) {
  loadWebMediaMock.mockResolvedValueOnce({ buffer, kind: undefined, contentType, fileName });
}

const image = {
  buffer: Buffer.from("frozen-image-bytes"),
  kind: "image",
  contentType: "image/png",
  fileName: "floor-plan.png",
} satisfies Awaited<ReturnType<typeof loadWebMediaType>>;

function serve(
  url: string,
  response: ReturnType<typeof makeRes>,
  account: ResolvedSynologyChatAccount,
  method = "GET",
) {
  return tryHandleSynologyHostedMediaRequest(makeReq(method, "", { url }), response, account);
}

function utf16Buffer(value: string, endian: "le" | "be", includeBom = true): Buffer {
  const buffer = Buffer.from(`${includeBom ? "\ufeff" : ""}${value}`, "utf16le");
  return endian === "le" ? buffer : buffer.swap16();
}

function utf32Buffer(value: string, endian: "le" | "be", includeBom = true): Buffer {
  const codePoints = Array.from(value, (character) => character.codePointAt(0) ?? 0xfffd);
  if (includeBom) {
    codePoints.unshift(0xfeff);
  }
  const buffer = Buffer.alloc(codePoints.length * 4);
  codePoints.forEach((codePoint, index) => {
    buffer.writeUInt32LE(codePoint, index * 4);
  });
  return endian === "le" ? buffer : buffer.swap32();
}

describe("Synology Chat hosted outbound media", () => {
  let account: ResolvedSynologyChatAccount;
  let runtime: ReturnType<typeof installRuntime>;
  const prepare = (mediaUrl = "https://files.example.com/report.pdf") =>
    prepareSynologyHostedMedia({ account, mediaUrl });
  const storeAt = (index: number) => expectDefined(runtime[index], "hosted media store");
  async function stageUrl(mediaUrl = "https://files.example.com/report.pdf") {
    return internalCapabilityUrl((await prepare(mediaUrl)).url);
  }
  async function get(url: string, method = "GET", requestAccount = account) {
    const response = makeRes();
    await serve(url, response, requestAccount, method);
    return response;
  }
  async function expectStatus(
    url: string,
    status: number,
    requestAccount = account,
    method = "GET",
  ) {
    expect((await get(url, method, requestAccount)).statusCode).toBe(status);
  }

  beforeEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    fs.rmSync(testStateDir, { recursive: true, force: true });
    fs.mkdirSync(testStateDir, { recursive: true });
    runtime = installRuntime();
    account = createAccount();
    loadWebMediaMock.mockReset();
    loadWebMediaMock.mockResolvedValue(image);
  });

  afterEach(() => {
    // Native worker drains use setImmediate after exit, including during afterAll cleanup.
    vi.useRealTimers();
  });

  it("requires an exact public HTTPS callback before preparing media", async () => {
    const publicUrl = "https://g.test/w";
    const credentialedUrl = new URL(publicUrl);
    credentialedUrl.username = "fixture-user";
    credentialedUrl.password = "fixture-password";
    for (const [webhookUrl, message] of [
      ["", "attachments require webhookUrl"],
      ["not-a-url", "must be an absolute HTTPS URL"],
      ["http://g.test/w", "must be an absolute HTTPS URL"],
      [credentialedUrl.toString(), "must be an absolute HTTPS URL"],
      [`${publicUrl}#fragment`, "must be an absolute HTTPS URL"],
      [
        `${publicUrl}?__openclaw_synology_media_token_existing=value`,
        "must not contain query parameters starting with",
      ],
    ] as const) {
      await expect(
        prepareSynologyHostedMedia({
          account: createAccount({ webhookUrl }),
          mediaUrl: "https://files.example.com/report.pdf",
        }),
      ).rejects.toThrow(message);
    }
    expect(loadWebMediaMock).not.toHaveBeenCalled();
  });

  it("reconstructs persisted bytes before response backpressure", async () => {
    const frozenBytes = Buffer.alloc(40 * 1024, 0x61);
    mockMedia(frozenBytes, "application/pdf", "report.pdf");
    const requestUrl = await stageUrl();
    const response = makeRes();
    const write = response.write.bind(response);
    response.write = ((chunk: Uint8Array | string) => {
      write(chunk);
      return false;
    }) as typeof response.write;
    const writeSpy = vi.spyOn(response, "write");
    let settled = false;
    const serving = serve(requestUrl, response, account).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    response.emit("drain");
    await expect(serving).resolves.toBe(true);
    expect(Buffer.from(response.body)).toEqual(frozenBytes);
  });

  it("rejects persisted corruption before writing response bytes", async () => {
    mockMedia(Buffer.alloc(40 * 1024, 0x61), "application/pdf", "report.pdf");
    const requestUrl = await stageUrl();
    const chunkStore = storeAt(1) as PluginStateKeyedStore<HostedOutboundMediaChunkRecord>;
    const chunk = (await chunkStore.entries()).find(({ value }) => value.index === 1);
    if (!chunk) {
      throw new Error("expected the second persisted payload chunk");
    }
    await chunkStore.register(chunk.key, {
      ...chunk.value,
      dataBase64: Buffer.from("truncated").toString("base64"),
    });
    const response = makeRes({ finishOnEnd: false });
    const writeSpy = vi.spyOn(response, "write");
    await expect(serve(requestUrl, response, account)).resolves.toBe(true);
    expect(response.statusCode).toBe(404);
    expect(response.destroyed).toBe(false);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(await chunkStore.entries()).toEqual([]);
  });

  it("keeps preparation limits after a fresh runtime initializes its stores", async () => {
    const { promise: loadGate, resolve: releaseLoads } = Promise.withResolvers<void>();
    loadWebMediaMock.mockImplementation(async () => {
      await loadGate;
      return image;
    });
    const first = prepare("https://files.example.com/one.png");
    const second = prepare("https://files.example.com/two.png");
    await vi.waitFor(() => expect(loadWebMediaMock).toHaveBeenCalledTimes(2));
    const third = prepare("https://files.example.com/three.png");
    await Promise.resolve();
    releaseLoads();
    await expect(third).rejects.toThrow("attachment preparation is busy");
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(loadWebMediaMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed for wrong tokens, accounts, routes, and unsupported methods", async () => {
    const prepared = await prepare();
    const requestUrl = internalCapabilityUrl(prepared.url);
    await expectStatus(withWrongToken(requestUrl), 401);
    await expectStatus(requestUrl, 404, createAccount({ accountId: "other" }));
    await expectStatus(internalCapabilityUrl(prepared.url, "/other"), 404);
    await expectStatus(requestUrl, 405, account, "POST");
  });

  it("bounds unauthenticated capability lookups before reading persistent state", async () => {
    const prepared = await prepare();
    const metadataStore = storeAt(0);
    const originalLookup = metadataStore.lookup.bind(metadataStore);
    const { promise: readGate, resolve: releaseReads } = Promise.withResolvers<void>();
    const lookupSpy = vi.spyOn(metadataStore, "lookup").mockImplementation(async (key) => {
      await readGate;
      return await originalLookup(key);
    });
    const requestUrl = withWrongToken(internalCapabilityUrl(prepared.url));
    const responses = Array.from({ length: 5 }, () => makeRes());
    const requests = responses.map((response) => serve(requestUrl, response, account));
    await vi.waitFor(() => expect(lookupSpy).toHaveBeenCalledTimes(4));
    expect(responses.filter((response) => response.statusCode === 503)).toHaveLength(1);
    releaseReads();
    await expect(Promise.all(requests)).resolves.toEqual([true, true, true, true, true]);
    expect(responses.map((response) => response.statusCode).toSorted((a, b) => a - b)).toEqual([
      401, 401, 401, 401, 503,
    ]);
  });

  it("holds serving slots through finish/close without releasing a new runtime's leases", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const previous = Array.from({ length: 4 }, () => makeRes({ finishOnEnd: false }));
    const current = Array.from({ length: 4 }, () => makeRes({ finishOnEnd: false }));
    try {
      const requestUrl = await stageUrl();
      await Promise.all(previous.map((response) => serve(requestUrl, response, account)));
      expect(previous.map((response) => response.statusCode)).toEqual([200, 200, 200, 200]);
      await expectStatus(requestUrl, 503);
      previous[0]?.emit("finish");
      await expectStatus(requestUrl, 200);
      installRuntime();
      for (const response of current) {
        await serve(requestUrl, response, account);
        expect(response.statusCode).toBe(200);
      }
      previous[1]?.emit("finish");
      await expectStatus(requestUrl, 503);
    } finally {
      for (const response of [...previous, ...current]) {
        response.emit("close");
      }
      vi.useRealTimers();
    }
  });

  it("closes stalled attachment responses and releases their serving slot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const requestUrl = await stageUrl();
    const stalled = makeRes({ finishOnEnd: false });
    await serve(requestUrl, stalled, account);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(stalled.destroyed).toBe(true);
    await expectStatus(requestUrl, 200);
  });

  it("starts the response deadline before persisted metadata can stall", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const requestUrl = await stageUrl();
    const metadataStore = storeAt(0);
    const lookup = metadataStore.lookup.bind(metadataStore);
    const { promise: lookupStarted, resolve: markLookupStarted } = Promise.withResolvers<void>();
    const { promise: lookupGate, resolve: releaseLookup } = Promise.withResolvers<void>();
    vi.spyOn(metadataStore, "lookup").mockImplementationOnce(async (key) => {
      markLookupStarted();
      await lookupGate;
      return await lookup(key);
    });
    const response = makeRes({ finishOnEnd: false });
    const pending = serve(requestUrl, response, account);
    await lookupStarted;
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(response.statusCode).toBe(504);
    expect(Buffer.from(response.body).toString("utf8")).toBe("Attachment response timed out");
    releaseLookup();
    await expect(pending).resolves.toBe(true);
    expect(response.statusCode).toBe(504);
  });

  it("bounds repeated authenticated downloads without charging HEAD requests", async () => {
    mockMedia(Buffer.alloc(32 * 1024 * 1024, 0x61), "application/pdf", "report.pdf");
    const requestUrl = await stageUrl();
    const chunkReads = trackChunkReads(storeAt(1));
    for (let index = 0; index < 4; index += 1) {
      const response = await get(requestUrl);
      expect(response.statusCode).toBe(200);
      await Promise.resolve();
    }
    const chunkReadsAtLimit = chunkReads();
    expect(chunkReadsAtLimit).toBeGreaterThan(0);
    await expectStatus(requestUrl, 200, account, "HEAD");
    const limited = await get(requestUrl);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(chunkReads()).toBe(chunkReadsAtLimit);
  });

  it("serves an immutable, header-safe persisted capability until expiry without refetching", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    mockMedia(image.buffer, image.contentType, '../quarter\r\nX-Evil: yes/"plan".pdf');
    const requestUrl = await stageUrl("https://files.example.com/floor-plan.png");
    resetPluginStateStoreForTests();
    installRuntime();
    loadWebMediaMock.mockResolvedValueOnce({
      ...image,
      buffer: Buffer.from("changed-source-bytes"),
      fileName: "changed.png",
    });
    const tampered = new URL(requestUrl, "http://localhost");
    tampered.searchParams.set("url", "http://127.0.0.1/private");
    tampered.searchParams.set("target", "https://files.example.com/changed.png");
    const response = await get(`${tampered.pathname}${tampered.search}`);
    expect(response.statusCode).toBe(200);
    expect(Buffer.from(response.body).toString("utf8")).toBe("frozen-image-bytes");
    expect(response.headers).not.toHaveProperty("location");
    const disposition = response.headers["content-disposition"] ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).not.toMatch(/[\r\n]/u);
    expect(disposition).not.toContain("../");
    await expect(
      serve("/internal/synology?target=http://127.0.0.1/private", makeRes(), account),
    ).resolves.toBe(false);
    vi.setSystemTime(1_700_000_000_000 + 10 * 60_000 + 1);
    await expectStatus(requestUrl, 404);
    expect(loadWebMediaMock).toHaveBeenCalledTimes(1);
  });

  const generic = ["application/octet-stream", "diagram.bin"] as const;
  const passive = ["image/png", "photo.png"] as const;
  const html = "<script>active()</script>";
  const svg = "<svg onload='active()'/>";
  it.each<[string, Buffer, string?, string?]>([
    ["explicit SVG", Buffer.from("<svg/>"), "image/svg+xml", "active.svg"],
    ["XML prefix", Buffer.from(`<?xml version="1.0"?><!--fixture-->${svg}`), ...generic],
    ["SVG doctype", Buffer.from(`<!DOCTYPE svg>${svg}`), ...generic],
    [
      "long wrappers",
      Buffer.from(`${" ".repeat(5_000)}${"<!--fixture-->".repeat(6)}${svg}`),
      ...generic,
    ],
    ["UTF-16LE HTML", utf16Buffer(html, "le"), ...passive],
    ["UTF-16BE SVG", utf16Buffer(`  <!--fixture-->${svg}`, "be"), ...passive],
    ["BOM-less UTF-16LE", utf16Buffer('<img src="x" onerror="alert(1)">', "le", false)],
    ["BOM-less UTF-16BE", utf16Buffer(`  <div>${html}</div>`, "be", false)],
    ["BOM-less UTF-32LE", utf32Buffer('<embed src="data:text/html,active">', "le", false)],
    ["UTF-32BE SVG", utf32Buffer(svg, "be"), ...passive],
    ["abrupt comment", Buffer.from(`<!-->${html}`)],
    ["comment-start-dash", Buffer.from(`<!--->${html}`)],
    ["incorrect comment close", Buffer.from(`<!--fixture--!>${html}`)],
    ["active filename", Buffer.from("not markup"), "application/octet-stream", "report.html"],
  ])(
    "rejects %s",
    async (_name, buffer, contentType = "application/octet-stream", fileName = "document.bin") => {
      mockMedia(buffer, contentType, fileName);
      await expect(prepare("https://files.example.com/disguised-content")).rejects.toThrow(
        "do not support active content type",
      );
      await expect(Promise.all(runtime.map((store) => store.entries()))).resolves.toEqual([[], []]);
    },
  );

  it("keeps passive BOM-less UTF-32 source text containing embedded markup available", async () => {
    const buffer = utf32Buffer("Example source: <div> is a literal tag.", "le", false);
    mockMedia(buffer, "text/plain", "example.txt");
    const response = await get(await stageUrl("https://files.example.com/example.txt"));
    expect(response.statusCode).toBe(200);
    expect(Buffer.from(response.body)).toEqual(buffer);
  });
});

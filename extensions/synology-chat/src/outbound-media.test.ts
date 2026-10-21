// Synology Chat tests cover guarded outbound attachment staging and same-route capability serving.
import fs from "node:fs";
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
import { makeReq, makeRes as makeBaseRes } from "./test-http-utils.js";
import type { ResolvedSynologyChatAccount } from "./types.js";

const loadWebMediaMock = vi.hoisted(() => vi.fn<typeof loadWebMediaType>());

function makeRes(options: { finishOnEnd?: boolean } = {}) {
  const res = makeBaseRes(options);
  const chunks: Buffer[] = [];
  const end = res.end.bind(res);
  res.write = ((chunk: Uint8Array | string) => {
    chunks.push(Buffer.from(chunk));
    return true;
  }) as typeof res.write;
  res.end = ((chunk?: Uint8Array | string) => {
    if (chunk !== undefined) {
      chunks.push(Buffer.from(chunk));
    }
    end(chunks.length > 0 ? Buffer.concat(chunks) : undefined);
    return res;
  }) as typeof res.end;
  return res;
}

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
  return {
    accountId: "default",
    enabled: true,
    token: "token",
    incomingUrl: "https://nas.example.com/incoming",
    webhookUrl: "https://gateway.example.com/public/synology?proxy-token=keep",
    nasHost: "nas.example.com",
    webhookPath: "/internal/synology",
    webhookPathSource: "explicit" as const,
    dangerouslyAllowNameMatching: false,
    dangerouslyAllowInheritedWebhookPath: false,
    dmPolicy: "allowlist" as const,
    allowedUserIds: ["42"],
    rateLimitPerMinute: 30,
    botName: "OpenClaw",
    allowInsecureSsl: false,
    ...overrides,
  } satisfies ResolvedSynologyChatAccount;
}

function installRuntime() {
  const openedStores: PluginStateKeyedStore<unknown>[] = [];
  let registerCallCount = 0;
  const openKeyedStore = vi.fn((options: OpenKeyedStoreOptions) => {
    const store = createPluginStateKeyedStoreForTests("synology-chat", {
      ...options,
      env: testStateEnv,
    });
    const register = store.register.bind(store);
    store.register = async (key, value, opts) => {
      registerCallCount += 1;
      await register(key, value, opts);
    };
    const exposedStore = { ...store, lookupMany: store.lookupMany };
    openedStores.push(exposedStore);
    return exposedStore;
  });
  setSynologyRuntime({ state: { openKeyedStore } } as unknown as PluginRuntime);
  return { openKeyedStore, openedStores, getRegisterCallCount: () => registerCallCount };
}

function trackChunkReads<T>(store: PluginStateKeyedStore<T>) {
  const lookup = vi.spyOn(store, "lookup");
  const lookupMany = store.lookupMany ? vi.spyOn(store, "lookupMany") : undefined;
  return () => lookup.mock.calls.length + (lookupMany?.mock.calls.length ?? 0);
}

function internalCapabilityUrl(publicUrl: string, pathName = "/internal/synology"): string {
  return `${pathName}${new URL(publicUrl).search}`;
}

function prepare(account: ResolvedSynologyChatAccount, mediaUrl: string) {
  return prepareSynologyHostedMedia({ account, mediaUrl });
}

function mockPdf(buffer: Buffer, fileName = "report.pdf") {
  loadWebMediaMock.mockResolvedValueOnce({
    buffer,
    kind: undefined,
    contentType: "application/pdf",
    fileName,
  });
}

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
  async function expectStatus(
    url: string,
    status: number,
    requestAccount = account,
    method = "GET",
  ) {
    const response = makeRes();
    await serve(url, response, requestAccount, method);
    expect(response.statusCode).toBe(status);
  }

  beforeEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    fs.rmSync(testStateDir, { recursive: true, force: true });
    fs.mkdirSync(testStateDir, { recursive: true });
    installRuntime();
    account = createAccount();
    loadWebMediaMock.mockReset();
    loadWebMediaMock.mockResolvedValue({
      buffer: Buffer.from("frozen-image-bytes"),
      kind: "image",
      contentType: "image/png",
      fileName: "floor-plan.png",
    });
  });

  afterEach(() => {
    // Native worker drains use setImmediate after exit, including during afterAll cleanup.
    vi.useRealTimers();
  });

  it("requires an exact public HTTPS callback before preparing media", async () => {
    const credentialedUrl = new URL("https://gateway.example.com/webhook");
    credentialedUrl.username = "fixture-user";
    credentialedUrl.password = "fixture-password";
    for (const [webhookUrl, message] of [
      ["", "attachments require webhookUrl"],
      ["not-a-url", "must be an absolute HTTPS URL"],
      ["http://gateway.example.com/webhook", "must be an absolute HTTPS URL"],
      [credentialedUrl.toString(), "must be an absolute HTTPS URL"],
      ["https://gateway.example.com/webhook#fragment", "must be an absolute HTTPS URL"],
      [
        "https://gateway.example.com/webhook?__openclaw_synology_media_token_existing=value",
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
    installRuntime();
    const frozenBytes = Buffer.alloc(40 * 1024, 0x61);
    mockPdf(frozenBytes);
    const prepared = await prepare(account, "https://files.example.com/report.pdf");
    const response = makeRes();
    const write = response.write.bind(response);
    let firstWrite = true;
    response.write = ((chunk: Uint8Array | string) => {
      write(chunk);
      if (firstWrite) {
        firstWrite = false;
        return false;
      }
      return true;
    }) as typeof response.write;
    const writeSpy = vi.spyOn(response, "write");
    let settled = false;

    const serving = serve(internalCapabilityUrl(prepared.url), response, account).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(writeSpy).toHaveBeenCalledOnce());
    expect(writeSpy).toHaveBeenCalledWith(frozenBytes);
    expect(settled).toBe(false);

    response.emit("drain");
    await expect(serving).resolves.toBe(true);
    expect(writeSpy).toHaveBeenCalledOnce();
    expect(Buffer.from(response.body)).toEqual(frozenBytes);
  });

  it("rejects persisted corruption before writing response bytes", async () => {
    const { openedStores } = installRuntime();
    mockPdf(Buffer.alloc(40 * 1024, 0x61));
    const prepared = await prepare(account, "https://files.example.com/report.pdf");
    const chunkStore = openedStores[1] as
      | PluginStateKeyedStore<HostedOutboundMediaChunkRecord>
      | undefined;
    if (!chunkStore) {
      throw new Error("expected hosted media chunk store");
    }
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

    await expect(serve(internalCapabilityUrl(prepared.url), response, account)).resolves.toBe(true);

    expect(response.statusCode).toBe(404);
    expect(response.destroyed).toBe(false);
    expect(writeSpy).not.toHaveBeenCalled();
    expect(await chunkStore.entries()).toEqual([]);
  });

  it("never treats capability query values as an on-demand fetch target", async () => {
    const prepared = await prepare(account, "https://files.example.com/floor-plan.png");
    const requestUrl = new URL(internalCapabilityUrl(prepared.url), "http://localhost");
    requestUrl.searchParams.set("url", "http://127.0.0.1/private");
    requestUrl.searchParams.set("target", "https://files.example.com/changed.png");
    const response = makeRes();

    await serve(`${requestUrl.pathname}${requestUrl.search}`, response, account);

    expect(response.statusCode).toBe(200);
    expect(Buffer.from(response.body).toString("utf8")).toBe("frozen-image-bytes");
    expect(response.headers).not.toHaveProperty("location");
    expect(loadWebMediaMock).toHaveBeenCalledTimes(1);

    const targetOnly = makeRes();
    await expect(
      serve("/internal/synology?target=http://127.0.0.1/private", targetOnly, account),
    ).resolves.toBe(false);
    expect(loadWebMediaMock).toHaveBeenCalledTimes(1);
  });

  it("keeps preparation limits after a fresh runtime initializes its stores", async () => {
    const { promise: loadGate, resolve: releaseLoads } = Promise.withResolvers<void>();
    loadWebMediaMock.mockImplementation(async () => {
      await loadGate;
      return {
        buffer: Buffer.from("frozen-image-bytes"),
        kind: "image",
        contentType: "image/png",
        fileName: "floor-plan.png",
      };
    });
    const first = prepare(account, "https://files.example.com/one.png");
    const second = prepare(account, "https://files.example.com/two.png");
    await vi.waitFor(() => expect(loadWebMediaMock).toHaveBeenCalledTimes(2));

    const third = prepare(account, "https://files.example.com/three.png");
    await Promise.resolve();
    releaseLoads();

    await expect(third).rejects.toThrow("attachment preparation is busy");
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(loadWebMediaMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed for wrong tokens, accounts, routes, and unsupported methods", async () => {
    const prepared = await prepare(account, "https://files.example.com/report.pdf");
    const capability = new URL(prepared.url);
    const tokenKey = [...capability.searchParams.keys()].find((key) =>
      key.startsWith("__openclaw_synology_media_token_"),
    );
    if (!tokenKey) {
      throw new Error("expected Synology hosted media token");
    }

    const wrongToken = new URLSearchParams(capability.search);
    wrongToken.set(tokenKey, "wrong");
    await expectStatus(`/internal/synology?${wrongToken.toString()}`, 401);

    await expectStatus(
      internalCapabilityUrl(prepared.url),
      404,
      createAccount({ accountId: "other" }),
    );

    await expectStatus(internalCapabilityUrl(prepared.url, "/other"), 404);

    await expectStatus(internalCapabilityUrl(prepared.url), 405, account, "POST");
  });

  it("bounds unauthenticated capability lookups before reading persistent state", async () => {
    const { openedStores } = installRuntime();
    const prepared = await prepare(account, "https://files.example.com/report.pdf");
    const metadataStore = openedStores[0];
    if (!metadataStore) {
      throw new Error("expected hosted media metadata store");
    }
    const originalLookup = metadataStore.lookup.bind(metadataStore);
    const { promise: readGate, resolve: releaseReads } = Promise.withResolvers<void>();
    const lookupSpy = vi.spyOn(metadataStore, "lookup").mockImplementation(async (key) => {
      await readGate;
      return await originalLookup(key);
    });
    const capability = new URL(internalCapabilityUrl(prepared.url), "http://localhost");
    const tokenKey = [...capability.searchParams.keys()].find((key) =>
      key.startsWith("__openclaw_synology_media_token_"),
    );
    if (!tokenKey) {
      throw new Error("expected Synology hosted media token");
    }
    capability.searchParams.set(tokenKey, "wrong");
    const requestUrl = `${capability.pathname}${capability.search}`;
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

  it("holds serving slots until responses finish or close", async () => {
    const prepared = await prepare(account, "https://files.example.com/report.pdf");
    const requestUrl = internalCapabilityUrl(prepared.url);
    const stalled = Array.from({ length: 4 }, () => makeRes({ finishOnEnd: false }));
    await Promise.all(stalled.map((response) => serve(requestUrl, response, account)));

    await expectStatus(requestUrl, 503);

    stalled[0]?.emit("finish");
    await expectStatus(requestUrl, 200);

    for (const response of stalled.slice(1)) {
      response.emit("close");
    }
  });

  it("does not release a new runtime's serving slot when an old response finishes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const previous = makeRes({ finishOnEnd: false });
    const current = Array.from({ length: 4 }, () => makeRes({ finishOnEnd: false }));
    try {
      const prepared = await prepare(account, "https://files.example.com/report.pdf");
      const requestUrl = internalCapabilityUrl(prepared.url);
      await serve(requestUrl, previous, account);
      expect(previous.statusCode).toBe(200);
      installRuntime();
      for (const response of current) {
        await serve(requestUrl, response, account);
        expect(response.statusCode).toBe(200);
      }
      previous.emit("finish");

      await expectStatus(requestUrl, 503);
    } finally {
      previous.emit("close");
      for (const response of current) {
        response.emit("close");
      }
      vi.useRealTimers();
    }
  });

  it("closes stalled attachment responses and releases their serving slot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    installRuntime();
    const prepared = await prepare(account, "https://files.example.com/report.pdf");
    const requestUrl = internalCapabilityUrl(prepared.url);
    const stalled = makeRes({ finishOnEnd: false });
    await serve(requestUrl, stalled, account);

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(stalled.destroyed).toBe(true);

    await expectStatus(requestUrl, 200);
  });

  it("starts the response deadline before persisted metadata can stall", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const { openedStores } = installRuntime();
    const prepared = await prepare(account, "https://files.example.com/report.pdf");
    const metadataStore = openedStores[0];
    if (!metadataStore) {
      throw new Error("expected hosted media metadata store");
    }
    const lookup = metadataStore.lookup.bind(metadataStore);
    const { promise: lookupStarted, resolve: markLookupStarted } = Promise.withResolvers<void>();
    const { promise: lookupGate, resolve: releaseLookup } = Promise.withResolvers<void>();
    vi.spyOn(metadataStore, "lookup").mockImplementationOnce(async (key) => {
      markLookupStarted();
      await lookupGate;
      return await lookup(key);
    });
    const response = makeRes({ finishOnEnd: false });
    const pending = serve(internalCapabilityUrl(prepared.url), response, account);

    await lookupStarted;
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(response.statusCode).toBe(504);
    expect(Buffer.from(response.body).toString("utf8")).toBe("Attachment response timed out");
    releaseLookup();
    await expect(pending).resolves.toBe(true);
    expect(response.statusCode).toBe(504);
  });

  it("bounds repeated authenticated downloads without charging HEAD requests", async () => {
    const { openedStores } = installRuntime();
    mockPdf(Buffer.alloc(32 * 1024 * 1024, 0x61));
    const prepared = await prepare(account, "https://files.example.com/report.pdf");
    const requestUrl = internalCapabilityUrl(prepared.url);
    const chunkStore = openedStores[1];
    if (!chunkStore) {
      throw new Error("expected hosted media chunk store");
    }
    const chunkReads = trackChunkReads(chunkStore);

    for (let index = 0; index < 4; index += 1) {
      const response = makeRes();
      await serve(requestUrl, response, account);
      expect(response.statusCode).toBe(200);
      await Promise.resolve();
    }
    const chunkReadsAtLimit = chunkReads();
    expect(chunkReadsAtLimit).toBeGreaterThan(0);

    const head = makeRes();
    await serve(requestUrl, head, account, "HEAD");
    expect(head.statusCode).toBe(200);

    const limited = makeRes();
    await serve(requestUrl, limited, account);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(chunkReads()).toBe(chunkReadsAtLimit);
  });

  it("persists frozen capabilities across plugin-state reopen and runtime replacement", async () => {
    const prepared = await prepare(account, "https://files.example.com/floor-plan.png");
    const requestUrl = internalCapabilityUrl(prepared.url);

    resetPluginStateStoreForTests();
    installRuntime();
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("changed-source-bytes"),
      kind: "image",
      contentType: "image/png",
      fileName: "changed.png",
    });
    const response = makeRes();
    await serve(requestUrl, response, account);

    expect(response.statusCode).toBe(200);
    expect(Buffer.from(response.body).toString("utf8")).toBe("frozen-image-bytes");
    expect(loadWebMediaMock).toHaveBeenCalledTimes(1);
  });

  it("rejects active content and leaves no live capability", async () => {
    const { getRegisterCallCount, openedStores } = installRuntime();
    loadWebMediaMock.mockResolvedValueOnce({
      buffer: Buffer.from("<svg onload=alert(1)></svg>"),
      kind: "image",
      contentType: "image/svg+xml",
      fileName: "active.svg",
    });
    await expect(prepare(account, "https://files.example.com/active.svg")).rejects.toThrow(
      "do not support active content type",
    );
    await expect(
      Promise.all(openedStores.map(async (store) => await store.entries())),
    ).resolves.toEqual([[], []]);
    expect(getRegisterCallCount()).toBe(0);
  });

  it.each<[string, Buffer, string?, string?]>([
    [
      "XML-prefixed SVG bytes with generic metadata",
      Buffer.from('<?xml version="1.0"?><!--fixture--><svg onload="alert(1)"/>'),
      "application/octet-stream",
      "diagram.bin",
    ],
    [
      "SVG doctype bytes with generic metadata",
      Buffer.from('<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'),
      "application/octet-stream",
      "diagram.bin",
    ],
    [
      "SVG bytes beyond long whitespace and repeated wrappers",
      Buffer.from(`${" ".repeat(5_000)}${"<!--fixture-->".repeat(6)}<svg onload="alert(1)"/>`),
      "application/octet-stream",
      "diagram.bin",
    ],
    [
      "UTF-16LE HTML bytes with passive metadata",
      utf16Buffer("<script>alert('active')</script>", "le"),
      "image/png",
      "photo.png",
    ],
    [
      "UTF-16BE SVG bytes with passive metadata",
      utf16Buffer('  <!--fixture--><svg onload="alert(1)"/>', "be"),
      "image/png",
      "photo.png",
    ],
    [
      "BOM-less UTF-16LE HTML bytes with generic metadata",
      utf16Buffer('<img src="x" onerror="alert(1)">', "le", false),
    ],
    [
      "BOM-less UTF-16BE HTML bytes with generic metadata",
      utf16Buffer("  <div><script>alert('active')</script></div>", "be", false),
    ],
    [
      "BOM-less UTF-32LE HTML bytes with generic metadata",
      utf32Buffer('<embed src="data:text/html,active">', "le", false),
    ],
    [
      "UTF-32BE SVG bytes with passive metadata",
      utf32Buffer('<svg onload="alert(1)"/>', "be"),
      "image/png",
      "photo.png",
    ],
    [
      "an abruptly closed comment before an active element",
      Buffer.from("<!--><script>alert('active')</script>"),
    ],
    [
      "an abruptly closed comment-start-dash before an active element",
      Buffer.from("<!---><script>alert('active')</script>"),
    ],
    [
      "an incorrectly closed comment before an active element",
      Buffer.from("<!--fixture--!><script>alert('active')</script>"),
    ],
    [
      "an active filename with generic content",
      Buffer.from("not markup"),
      "application/octet-stream",
      "report.html",
    ],
  ])(
    "rejects %s",
    async (_name, buffer, contentType = "application/octet-stream", fileName = "document.bin") => {
      loadWebMediaMock.mockResolvedValueOnce({
        buffer,
        kind: undefined,
        contentType,
        fileName,
      });
      await expect(prepare(account, "https://files.example.com/disguised-content")).rejects.toThrow(
        "do not support active content type",
      );
    },
  );

  it("keeps passive BOM-less UTF-32 source text containing embedded markup available", async () => {
    const buffer = utf32Buffer("Example source: <div> is a literal tag.", "le", false);
    loadWebMediaMock.mockResolvedValueOnce({
      buffer,
      kind: undefined,
      contentType: "text/plain",
      fileName: "example.txt",
    });
    const prepared = await prepare(account, "https://files.example.com/example.txt");
    const response = makeRes();

    await serve(internalCapabilityUrl(prepared.url), response, account);

    expect(response.statusCode).toBe(200);
    expect(Buffer.from(response.body)).toEqual(buffer);
  });

  it("sanitizes response filenames before constructing headers", async () => {
    mockPdf(Buffer.from("pdf"), '../quarter\r\nX-Evil: yes/"plan".pdf');
    const prepared = await prepare(account, "https://files.example.com/report.pdf");
    const response = makeRes();
    await serve(internalCapabilityUrl(prepared.url), response, account);
    const disposition = response.headers["content-disposition"] ?? "";
    expect(disposition).toContain("attachment");
    expect(disposition).not.toMatch(/[\r\n]/u);
    expect(disposition).not.toContain("../");
  });

  it("expires capabilities without falling back to the source URL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    installRuntime();
    const prepared = await prepare(account, "https://files.example.com/report.pdf");
    vi.setSystemTime(1_700_000_000_000 + 10 * 60_000 + 1);
    const response = makeRes();
    await serve(internalCapabilityUrl(prepared.url), response, account);
    expect(response.statusCode).toBe(404);
    expect(loadWebMediaMock).toHaveBeenCalledTimes(1);
  });
});

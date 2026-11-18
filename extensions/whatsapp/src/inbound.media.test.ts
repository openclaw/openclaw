import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as waitForLogTick } from "node:timers/promises";
import type { proto } from "baileys";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import { resolveRequestUrl } from "openclaw/plugin-sdk/request-url";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  mockExtractMessageContent,
  mockGetContentType,
  mockIsJidGroup,
  mockNormalizeMessageContent,
} from "../../../test/mocks/baileys.js";
import { lookupInboundMessageMeta } from "./quoted-message.js";

type MockMessageInput = Parameters<typeof mockNormalizeMessageContent>[0];
type InMemoryKeyedStoreEntry<T> = {
  key: string;
  value: T;
  createdAt: number;
  expiresAt?: number;
};

function createInMemoryKeyedStore<T>() {
  const entries = new Map<string, InMemoryKeyedStoreEntry<T>>();
  function store(key: string, value: T, opts?: { ttlMs?: number }) {
    const createdAt = Date.now();
    entries.set(key, {
      key,
      value,
      createdAt,
      ...(opts?.ttlMs ? { expiresAt: createdAt + opts.ttlMs } : {}),
    });
  }
  return {
    async register(key: string, value: T, opts?: { ttlMs?: number }) {
      store(key, value, opts);
    },
    async registerIfAbsent(key: string, value: T, opts?: { ttlMs?: number }) {
      if (entries.has(key)) {
        return false;
      }
      store(key, value, opts);
      return true;
    },
    lookup: async (key: string) => entries.get(key)?.value,
    async consume(key: string) {
      const value = entries.get(key)?.value;
      entries.delete(key);
      return value;
    },
    delete: async (key: string) => entries.delete(key),
    entries: async () => Array.from(entries.values()),
    clear: async () => entries.clear(),
  };
}

const readAllowFromStoreMock = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const upsertPairingRequestMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ code: "PAIRCODE", created: true }),
);
const saveMediaStreamSpy = vi.fn();
const downloadMediaMessageMock = vi.hoisted(() => vi.fn());
const observedConsoleWarnings = vi.hoisted(() => vi.fn());
function createMockSocket() {
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  return {
    authState: { creds: { accountSyncCounter: 0 } },
    ev: new EventEmitter(),
    ws: { close: vi.fn() },
    sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    readMessages: vi.fn().mockResolvedValue(undefined),
    groupFetchAllParticipating: vi.fn().mockResolvedValue({}),
    updateMediaMessage: vi.fn(),
    getMediaHost: () => "media-conn.example",
    logger: {},
    user: { id: "me@s.whatsapp.net" },
  };
}
let currentMockSocket: ReturnType<typeof createMockSocket> | undefined;

vi.mock("openclaw/plugin-sdk/logging-core", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/logging-core")>(
    "openclaw/plugin-sdk/logging-core",
  );
  function observeConsoleWarnings(
    logger: ReturnType<typeof actual.createSubsystemLogger>,
  ): ReturnType<typeof actual.createSubsystemLogger> {
    return {
      ...logger,
      warn(message, meta) {
        if (logger.isEnabled("warn", "console")) {
          observedConsoleWarnings(message, meta);
        }
        logger.warn(message, meta);
      },
      child(name) {
        return observeConsoleWarnings(logger.child(name));
      },
    };
  }
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) =>
      observeConsoleWarnings(actual.createSubsystemLogger(subsystem)),
  };
});

vi.mock(import("openclaw/plugin-sdk/runtime-config-snapshot"), async (importOriginal) => ({
  ...(await importOriginal()),
  readRuntimeConfig: vi.fn().mockReturnValue({
    channels: {
      whatsapp: {
        allowFrom: ["*"],
      },
    },
    messages: {
      messagePrefix: undefined,
      responsePrefix: undefined,
    },
  }),
}));

vi.mock(import("openclaw/plugin-sdk/conversation-runtime"), async (importOriginal) => ({
  ...(await importOriginal()),
  readChannelAllowFromStore: readAllowFromStoreMock,
  upsertChannelPairingRequest: upsertPairingRequestMock,
}));

vi.mock(import("openclaw/plugin-sdk/channel-pairing"), async (importOriginal) => ({
  ...(await importOriginal()),
  readChannelAllowFromStore: readAllowFromStoreMock,
}));

vi.mock("openclaw/plugin-sdk/media-store", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/media-store")>(
    "openclaw/plugin-sdk/media-store",
  );
  return {
    ...actual,
    saveMediaStream: vi.fn(async (...args: Parameters<typeof actual.saveMediaStream>) => {
      saveMediaStreamSpy(...args);
      return actual.saveMediaStream(...args);
    }),
  };
});

vi.mock("./runtime.js", async () => {
  const { createPluginRuntimeMock } = await import("openclaw/plugin-sdk/channel-test-helpers");
  const { createChannelIngressQueueForTests: createChannelIngressQueue } = await Promise.resolve(
    vi.importActual<typeof import("openclaw/plugin-sdk/plugin-state-test-runtime")>(
      "openclaw/plugin-sdk/plugin-state-test-runtime",
    ),
  );
  const stateDir = `/tmp/openclaw-whatsapp-inbound-media-${Date.now()}-${Math.random()}`;
  const channelRuntime = createPluginRuntimeMock().channel;
  return {
    getWhatsAppChannelRuntime: () => channelRuntime,
    getOptionalWhatsAppRuntime: () => undefined,
    getWhatsAppRuntime: () => ({
      channel: channelRuntime,
      state: {
        resolveStateDir: () => stateDir,
        openKeyedStore: () => createInMemoryKeyedStore(),
        openChannelIngressQueue: (
          options?: Omit<Parameters<typeof createChannelIngressQueue>[0], "channelId">,
        ) => createChannelIngressQueue({ ...options, channelId: "whatsapp" }),
      },
    }),
    setWhatsAppRuntime: vi.fn(),
  };
});

const HOME = path.join(os.tmpdir(), `openclaw-inbound-media-${crypto.randomUUID()}`);
vi.stubEnv("HOME", HOME);

vi.mock("baileys", async () => {
  const actual = await vi.importActual<typeof import("baileys")>("baileys");
  const { Readable } = require("node:stream") as typeof import("node:stream");
  const jpegBuffer = Buffer.from(
    "ffd8ffdb004300030202020202030202020303030304060404040404080606050609080a0a090809090a0c0f0c0a0b0e0b09090d110d0e0f101011100a0c12131210130f101010ffc00011080001000103011100021101031101ffc400140001010000000000000000000000000000ffc40014100100000000000000000000000000ffda000c03010002110311003f00ffd9",
    "hex",
  );
  return {
    ...actual,
    downloadMediaMessage: downloadMediaMessageMock.mockImplementation(() =>
      Readable.from([jpegBuffer]),
    ),
    extractMessageContent: vi.fn((message: MockMessageInput) => mockExtractMessageContent(message)),
    getContentType: vi.fn((message: MockMessageInput) => mockGetContentType(message)),
    isJidGroup: vi.fn((jid: string | undefined | null) => mockIsJidGroup(jid)),
    normalizeMessageContent: vi.fn((message: MockMessageInput) =>
      mockNormalizeMessageContent(message),
    ),
  };
});

vi.mock("./session.js", async () => {
  const actual = await vi.importActual<typeof import("./session.js")>("./session.js");
  return {
    ...actual,
    createWaSocket: vi.fn(async () => (currentMockSocket ??= createMockSocket())),
    waitForWaConnection: vi.fn().mockResolvedValue(undefined),
    getStatusCode: vi.fn(() => 200),
  };
});

let monitorWebInbox: typeof import("./inbound/monitor.js").monitorWebInbox;
let resetWebInboundDedupe: typeof import("./inbound/dedupe.js").resetWebInboundDedupe;
let createWaSocket: typeof import("./session.js").createWaSocket;
let resetLogger: typeof import("openclaw/plugin-sdk/runtime-env").resetLogger;
let setLoggerOverride: typeof import("openclaw/plugin-sdk/runtime-env").setLoggerOverride;

const LOG_PATH = path.join(os.tmpdir(), `openclaw-inbound-media-${crypto.randomUUID()}.log`);
const DIRECT_SYNTHETIC_BEARER = "synthetic-direct-bearer-never-real";
const QUOTED_SYNTHETIC_API_KEY = "synthetic-quoted-api-key-never-real";
const DEPLOYMENT_REDACTION_SENTINEL = "deployment-secret-never-real";

async function waitForMessage(onMessage: ReturnType<typeof vi.fn>) {
  // Saturated no-isolate suite runs can stall the worker (sync module fetches
  // against the shared transform queue) well past a 2s delivery budget.
  await vi.waitFor(() => expect(onMessage).toHaveBeenCalledTimes(1), {
    interval: 1,
    timeout: 5_000,
  });
  return onMessage.mock.calls[0]?.[0];
}

function latestSaveMediaStreamCall() {
  const call = saveMediaStreamSpy.mock.calls[saveMediaStreamSpy.mock.calls.length - 1];
  assert(call, "expected saveMediaStream call");
  return call;
}

function requireMediaPath(value: unknown): string {
  assert(typeof value === "string" && value.length > 0, "expected inbound media path");
  return value;
}

// The async file transport's flush promise is not exposed through the plugin SDK.
async function waitForLogLine(messageId: string, signal: AbortSignal): Promise<string> {
  for (;;) {
    signal.throwIfAborted();
    const content = await withinTest(
      fs.readFile(LOG_PATH, "utf8").catch((error: unknown) => {
        if (extractErrorCode(error) === "ENOENT") {
          return "";
        }
        throw error;
      }),
      signal,
    );
    const matchingLine = content
      .split("\n")
      .find(
        (line) =>
          line.includes("WhatsApp inbound media materialization failed") &&
          line.includes(messageId),
      );
    if (matchingLine) {
      return matchingLine;
    }
    await waitForLogTick(10, undefined, { signal });
  }
}

async function createBaileysMediaHttpError(statusCode: number, details: string): Promise<Error> {
  const fetchSpy = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(new Response(null, { status: statusCode }));
  try {
    const { getHttpStream } = await vi.importActual<typeof import("baileys")>("baileys");
    await getHttpStream("https://media.example/private");
  } catch (error) {
    assert(error instanceof Error, "expected Baileys to reject media downloads with an Error");
    error.message = `${error.message} ${details}`;
    return error;
  } finally {
    fetchSpy.mockRestore();
  }
  throw new Error("expected Baileys to reject the failed media response");
}

const imageMessage = () => ({ imageMessage: { mimetype: "image/jpeg" } });
function quotedReply(text: string, contextInfo: proto.IContextInfo): proto.IMessage {
  return { extendedTextMessage: { text, contextInfo } };
}

function expectExcluded(text: string | undefined, values: readonly string[]) {
  for (const value of values) {
    expect(text).not.toContain(value);
  }
}

async function expectFailureDiagnostics(
  messageId: string,
  stage: "direct" | "quoted",
  excluded: readonly string[],
  signal: AbortSignal,
) {
  const diagnostic = await waitForLogLine(messageId, signal);
  for (const field of [
    '"channel":"whatsapp"',
    '"mediaKind":"image"',
    '"mimeType":"image/jpeg"',
    `"failureStage":"${stage}"`,
    '"errorClass":"Error"',
    '"statusCode":410',
  ]) {
    expect(diagnostic).toContain(field);
  }
  expectExcluded(diagnostic, excluded);
  const terminal = observedConsoleWarnings.mock.calls.find(
    ([message]) => message === "WhatsApp inbound media materialization failed",
  )?.[1]?.consoleMessage;
  expect(terminal).toBe(
    `WhatsApp inbound media materialization failed (stage=${stage} class=Error kind=image status=410)`,
  );
  expectExcluded(terminal, excluded);
}

describe("web inbound media saves with extension", () => {
  async function startMediaCase(mediaMaxMb?: number) {
    const onMessage = vi.fn();
    const listener = await monitorWebInbox({
      cfg: { channels: { whatsapp: { allowFrom: ["*"] } } },
      verbose: false,
      onMessage,
      accountId: "default",
      authDir: path.join(HOME, "wa-auth"),
      ...(mediaMaxMb === undefined ? {} : { mediaMaxMb }),
    });
    onTestFinished(() => listener.close());
    const sock = await createWaSocket(false, false);
    const send = (id: string, message: proto.IMessage, remoteJid = "111@s.whatsapp.net") =>
      sock.ev.emit("messages.upsert", {
        type: "notify",
        messages: [
          { key: { id, fromMe: false, remoteJid }, message, messageTimestamp: 1_700_000_000 },
        ],
      });
    return { onMessage, send };
  }

  beforeEach(() => {
    vi.stubEnv("HOME", HOME);
    vi.useRealTimers();
    currentMockSocket = undefined;
    downloadMediaMessageMock.mockClear();
    observedConsoleWarnings.mockClear();
    saveMediaStreamSpy.mockClear();
    resetWebInboundDedupe();
  });

  beforeAll(async () => {
    await fs.rm(HOME, { recursive: true, force: true });
    const configDir = path.join(HOME, ".openclaw");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(
      path.join(configDir, "openclaw.json"),
      JSON.stringify({ logging: { redactPatterns: ["deployment-secret-[a-z-]+"] } }),
    );
    ({ resetLogger, setLoggerOverride } = await import("openclaw/plugin-sdk/runtime-env"));
    setLoggerOverride({ level: "trace", consoleLevel: "info", file: LOG_PATH });
    ({ monitorWebInbox } = await import("./inbound/monitor.js"));
    ({ resetWebInboundDedupe } = await import("./inbound/dedupe.js"));
    ({ createWaSocket } = await import("./session.js"));
  });

  afterAll(async () => {
    resetLogger();
    setLoggerOverride(null);
    await fs.rm(LOG_PATH, { force: true });
    await fs.rm(HOME, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("stores image extension and keeps document filename", async () => {
    const { onMessage, send } = await startMediaCase(1);

    send("img1", imageMessage());

    const first = await waitForMessage(onMessage);
    const mediaPath = requireMediaPath(first.payload.media?.path);
    expect(path.extname(mediaPath)).toBe(".jpg");
    const stat = await fs.stat(mediaPath);
    expect(stat.size).toBeGreaterThan(0);
    expect(latestSaveMediaStreamCall()[3]).toBe(1024 * 1024);

    onMessage.mockClear();
    const fileName = "invoice.pdf";
    send(
      "doc1",
      { documentMessage: { mimetype: "application/pdf", fileName } },
      "333@s.whatsapp.net",
    );

    const second = await waitForMessage(onMessage);
    expect(second.payload.media?.fileName).toBe(fileName);
    expect(saveMediaStreamSpy).toHaveBeenCalled();
    const lastCall = latestSaveMediaStreamCall();
    expect(lastCall[4]).toBe(fileName);
  });

  it("stores quoted image media from reply context", async () => {
    const { onMessage, send } = await startMediaCase();

    send(
      "quote-img-reply",
      quotedReply("@bot what is this?", {
        stanzaId: "quoted-image",
        participant: "222@s.whatsapp.net",
        mentionedJid: ["me@s.whatsapp.net"],
        quotedMessage: imageMessage(),
      }),
      "111@g.us",
    );

    const inbound = await waitForMessage(onMessage);
    expect(inbound.quote?.body).toBe("");
    expect(inbound.quote?.media).toEqual({ contentType: "image/jpeg", kind: "image" });
    const mediaPath = requireMediaPath(inbound.payload.media?.path);
    expect(path.extname(mediaPath)).toBe(".jpg");
    expect(saveMediaStreamSpy).toHaveBeenCalled();
    const lastCall = latestSaveMediaStreamCall();
    expect(lastCall[1]).toBe("image/jpeg");
    expect(
      lookupInboundMessageMeta("default", "111@g.us", "quote-img-reply")?.media,
    ).toBeUndefined();
  });

  it("preserves self-authored quoted media through the real Baileys reupload boundary", async () => {
    const { onMessage, send } = await startMediaCase();

    send(
      "quote-own-image",
      quotedReply("what is in your image?", {
        stanzaId: "bot-image",
        participant: "me@s.whatsapp.net",
        quotedMessage: imageMessage(),
      }),
    );

    await waitForMessage(onMessage);
    const quoted = downloadMediaMessageMock.mock.calls[0]?.[0] as
      | { key?: { fromMe?: boolean; id?: string; remoteJid?: string } }
      | undefined;
    expect(quoted?.key).toMatchObject({ fromMe: true, id: "bot-image" });

    const { encryptMediaRetryRequest } = await vi.importActual<typeof import("baileys")>("baileys");
    const retry = encryptMediaRetryRequest(
      quoted!.key as never,
      Buffer.alloc(32, 1),
      "me@s.whatsapp.net",
    );
    const retryNode = Array.isArray(retry.content)
      ? retry.content.find((node) => node.tag === "rmr")
      : undefined;
    expect(retryNode?.attrs.from_me).toBe("true");
  });

  it("delivers incoming video notes as normal video media", async () => {
    const { onMessage, send } = await startMediaCase();

    send("video-note-1", { ptvMessage: { mimetype: "video/mp4" } });

    const inbound = await waitForMessage(onMessage);
    expect(inbound.payload.media).toMatchObject({ kind: "video", type: "video/mp4" });
    expect(inbound.payload.media?.path).toBeTruthy();
    expect(downloadMediaMessageMock).toHaveBeenCalled();
  });

  it.for([
    { urlHost: "a.whatsapp.net", fetchHost: "media-conn.example" },
    // Recorded WhatsApp Web stickers carry the bare host as url (WhiskeySockets/Baileys#1085, #1557).
    { urlHost: "web.whatsapp.net", fetchHost: "media-conn.example", bareUrl: true },
    { urlHost: "mmg.whatsapp.net", fetchHost: "mmg.whatsapp.net" },
    { urlHost: "custom-cdn.example", fetchHost: "custom-cdn.example" },
  ])(
    "downloads a sticker whose url is on $urlHost from $fetchHost",
    async ({ urlHost, fetchHost, bareUrl }) => {
      const { downloadMediaMessage, getMediaKeys } =
        await vi.importActual<typeof import("baileys")>("baileys");
      downloadMediaMessageMock.mockImplementationOnce(downloadMediaMessage);

      // 1x1 lossless WebP.
      const sticker = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");
      const mediaKey = crypto.randomBytes(32);
      const { cipherKey, iv } = await getMediaKeys(mediaKey, "sticker");
      const cipher = crypto.createCipheriv("aes-256-cbc", cipherKey, iv);
      const encrypted = Buffer.concat([cipher.update(sticker), cipher.final()]);
      const directPath = "/v/t62.15575-24/sticker.enc?ccb=11-4";
      const fetchUrl = `https://${fetchHost}${directPath}`;
      // Any other host fails the way undici fails a host with no DNS record.
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input) =>
          resolveRequestUrl(input) === fetchUrl
            ? new Response(encrypted)
            : Promise.reject(new TypeError("fetch failed")),
        );
      onTestFinished(() => fetchSpy.mockRestore());

      const { onMessage, send } = await startMediaCase();

      send(`sticker-${urlHost}`, {
        stickerMessage: {
          url: bareUrl ? `https://${urlHost}` : `https://${urlHost}${directPath}`,
          directPath,
          mediaKey,
          mimetype: "image/webp",
        },
      });

      const inbound = await waitForMessage(onMessage);
      expect(fetchSpy.mock.calls.map(([input]) => resolveRequestUrl(input))).toEqual([fetchUrl]);
      expect(inbound.payload.media?.type).toBe("image/webp");
      const mediaPath = requireMediaPath(inbound.payload.media?.path);
      expect(await fs.readFile(mediaPath)).toEqual(sticker);
    },
  );

  it("delivers native polls and preserves their questions when quoted", async () => {
    const { onMessage, send } = await startMediaCase();
    const poll = {
      name: "Lunch?",
      options: [{ optionName: "Pizza" }, { optionName: "Sushi" }],
    };

    send("poll-1", { pollCreationMessageV3: poll });

    expect((await waitForMessage(onMessage)).payload.body).toBe("Lunch?\n- Pizza\n- Sushi");
    onMessage.mockClear();

    send(
      "poll-reply",
      quotedReply("Pizza, please", {
        stanzaId: "poll-1",
        participant: "111@s.whatsapp.net",
        quotedMessage: { pollCreationMessageV3: poll },
      }),
    );

    expect((await waitForMessage(onMessage)).quote).toMatchObject({
      id: "poll-1",
      body: "Lunch?\n- Pizza\n- Sushi",
    });
  });

  it.for([
    {
      stage: "direct",
      id: "img-failed",
      body: "[whatsapp attachment unavailable]",
      command: "",
      details: `expired media reference +15551234567 111@s.whatsapp.net 789@hosted.lid 42@c.us Authorization: Bearer ${DIRECT_SYNTHETIC_BEARER} ${DEPLOYMENT_REDACTION_SENTINEL}`,
      excluded: [
        "expired media reference",
        "media.example/private",
        "+15551234567",
        "111@s.whatsapp.net",
        "789@hosted.lid",
        "42@c.us",
        DIRECT_SYNTHETIC_BEARER,
        DEPLOYMENT_REDACTION_SENTINEL,
      ],
    },
    {
      stage: "quoted",
      id: "quoted-failed",
      body: "inspect this\n\n[whatsapp quoted attachment unavailable]",
      command: "inspect this",
      details: `quoted media reference expired 7@hosted 88@newsletter api_key=${QUOTED_SYNTHETIC_API_KEY} ${DEPLOYMENT_REDACTION_SENTINEL}`,
      excluded: [
        "quoted media reference expired",
        "7@hosted",
        "88@newsletter",
        QUOTED_SYNTHETIC_API_KEY,
        DEPLOYMENT_REDACTION_SENTINEL,
      ],
    },
  ] as const)(
    "preserves $stage failed media and redacts diagnostics",
    async (scenario, { signal }) => {
      downloadMediaMessageMock.mockRejectedValueOnce(
        await createBaileysMediaHttpError(410, scenario.details),
      );
      const { onMessage, send } = await startMediaCase();
      const message =
        scenario.stage === "direct"
          ? imageMessage()
          : quotedReply("inspect this", {
              stanzaId: "quoted-image-failed",
              participant: "222@s.whatsapp.net",
              quotedMessage: imageMessage(),
            });
      send(scenario.id, message);
      const inbound = await waitForMessage(onMessage);
      expect(inbound.payload).toMatchObject({ body: scenario.body, commandBody: scenario.command });
      if (scenario.stage === "direct") {
        expect(inbound.payload.media).toEqual({
          path: undefined,
          type: "image/jpeg",
          fileName: undefined,
          kind: "image",
        });
        expect(inbound.payload.channelStructuredContext).toContainEqual({
          label: "WhatsApp media",
          source: "whatsapp",
          type: "media",
          payload: { contentType: "image/jpeg", kind: "image" },
        });
      }
      await expectFailureDiagnostics(scenario.id, scenario.stage, scenario.excluded, signal);
    },
  );
});

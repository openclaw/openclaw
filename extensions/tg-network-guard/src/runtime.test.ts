import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import register from "./runtime.js";

type FetchCall = {
  method: string;
  payload: Record<string, unknown>;
};

const INSTALL_KEY = Symbol.for("openclaw.tg_network_guard.installed");
const originalFetch = globalThis.fetch;
const originalSetTimeout = globalThis.setTimeout;
const originalToken = process.env.OPENCLAW_TELEGRAM_BOT_TOKEN;

function parseTelegramMethod(url: string): string {
  const m = String(url || "").match(/\/bot[^/]+\/([^/?#]+)/);
  return m?.[1] || "";
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  intervalMs = 20,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.setTimeout = originalSetTimeout;
  delete (globalThis as Record<PropertyKey, unknown>)[INSTALL_KEY];
  if (originalToken == null) {
    delete process.env.OPENCLAW_TELEGRAM_BOT_TOKEN;
  } else {
    process.env.OPENCLAW_TELEGRAM_BOT_TOKEN = originalToken;
  }
  vi.restoreAllMocks();
});

describe("tg-network-guard", () => {
  it("sends transcribing status, transcript reply, and marks status as transcribed", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-tg-network-guard-test-"));
    const mediaPath = path.join(tmp, "voice-note.ogg");
    fs.writeFileSync(mediaPath, "fake-ogg-bytes");

    const whisperStubPath = path.join(tmp, "whisper");
    fs.writeFileSync(
      whisperStubPath,
      `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const argv = process.argv.slice(2);
const inputFile = argv[0];
let outDir = ".";
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === "--output_dir" && argv[i + 1]) {
    outDir = argv[i + 1];
  }
}
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, path.parse(inputFile).name + ".txt");
fs.writeFileSync(outPath, "This is a deterministic transcript.");
`,
      { mode: 0o755 },
    );

    const calls: FetchCall[] = [];
    let sendMessageCounter = 0;
    const fetchStub: typeof fetch = (async (input, init = {}) => {
      const url =
        typeof input === "string" ? input : String((input as { url?: string })?.url || "");
      const method = parseTelegramMethod(url);
      let payload: Record<string, unknown> = {};
      try {
        payload = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      } catch {
        payload = {};
      }
      calls.push({ method, payload });

      if (method === "sendMessage") {
        sendMessageCounter += 1;
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () =>
            JSON.stringify({
              ok: true,
              result: { message_id: sendMessageCounter === 1 ? 9001 : 9002 },
            }),
        } as Response;
      }

      if (method === "editMessageText") {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ ok: true, result: true }),
        } as Response;
      }

      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ ok: true, result: true }),
      } as Response;
    }) as typeof fetch;

    globalThis.fetch = fetchStub;
    globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => {
      const timer = originalSetTimeout(...args);
      const delay = Number(args[1]);
      // Let long-lived cleanup timers be detached so the test exits promptly.
      if (delay >= 30_000 && timer && typeof (timer as NodeJS.Timeout).unref === "function") {
        (timer as NodeJS.Timeout).unref();
      }
      return timer;
    }) as typeof setTimeout;
    process.env.OPENCLAW_TELEGRAM_BOT_TOKEN = "test-token";

    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    const logs: string[] = [];
    const api = {
      pluginConfig: {
        enabled: true,
        ownerChatId: "1336356696",
        ackVoiceMessages: false,
        transcribeVoiceMessages: true,
        transcribingText: "Transcribing...",
        transcribedText: "Transcribed.",
        transcriptPrefix: "Transcript:",
        whisperCommand: whisperStubPath,
        whisperModel: "tiny",
        whisperTimeoutMs: 20000,
      },
      logger: {
        info: (m: string) => logs.push(`info:${String(m)}`),
        warn: (m: string) => logs.push(`warn:${String(m)}`),
      },
      on(eventName: string, handler: (event: unknown, ctx: unknown) => void) {
        handlers.set(eventName, handler);
      },
    } as unknown as OpenClawPluginApi;

    register(api);
    const onMessage = handlers.get("message_received");
    expect(onMessage).toBeTypeOf("function");

    onMessage?.(
      {
        from: "telegram:1336356696",
        content: `<media:audio>\n[media attached: ${mediaPath} (audio/ogg; codecs=opus) | ${mediaPath}]\n[message_id: 321]`,
      },
      { channelId: "telegram", conversationId: "telegram:1336356696" },
    );

    const done = await waitFor(
      () =>
        calls.filter((c) => c.method === "sendMessage").length >= 2 &&
        calls.some((c) => c.method === "editMessageText"),
    );
    expect(done).toBe(true);

    const sendCalls = calls.filter((c) => c.method === "sendMessage");
    expect(sendCalls.length).toBeGreaterThanOrEqual(2);
    const statusSendCall = sendCalls.find((c) => c.payload.text === "Transcribing...");
    expect(statusSendCall).toBeTruthy();
    expect(statusSendCall?.payload.reply_to_message_id).toBe(321);

    const transcriptSendCall = sendCalls.find((c) =>
      String(c.payload.text || "").includes("Transcript:\nThis is a deterministic transcript."),
    );
    expect(transcriptSendCall).toBeTruthy();
    expect(transcriptSendCall?.payload.reply_to_message_id).toBe(321);

    const editCall = calls.find((c) => c.method === "editMessageText");
    expect(editCall).toBeTruthy();
    expect(String(editCall?.payload.text || "")).toBe("Transcribed.");
    expect(editCall?.payload.message_id).toBe(9001);

    // Scenario 2: voice payload without inline media path, fallback to event metadata path.
    calls.length = 0;
    sendMessageCounter = 0;
    onMessage?.(
      {
        from: "telegram:1336356696",
        content: "<media:voice>\n[message_id: 654]",
        metadata: { mediaPath },
      },
      { channelId: "telegram", conversationId: "telegram:1336356696" },
    );

    const doneMeta = await waitFor(
      () =>
        calls.filter((c) => c.method === "sendMessage").length >= 2 &&
        calls.some((c) => c.method === "editMessageText"),
    );
    expect(doneMeta).toBe(true);

    const sendCallsMeta = calls.filter((c) => c.method === "sendMessage");
    expect(sendCallsMeta.length).toBeGreaterThanOrEqual(2);
    const statusSendCallMeta = sendCallsMeta.find((c) => c.payload.text === "Transcribing...");
    expect(statusSendCallMeta).toBeTruthy();
    expect(statusSendCallMeta?.payload.reply_to_message_id).toBe(654);

    const transcriptSendCallMeta = sendCallsMeta.find((c) =>
      String(c.payload.text || "").includes("Transcript:\nThis is a deterministic transcript."),
    );
    expect(transcriptSendCallMeta).toBeTruthy();
    expect(transcriptSendCallMeta?.payload.reply_to_message_id).toBe(654);

    const editCallMeta = calls.find((c) => c.method === "editMessageText");
    expect(editCallMeta).toBeTruthy();
    expect(String(editCallMeta?.payload.text || "")).toBe("Transcribed.");

    const warningLogs = logs.filter((l) => l.startsWith("warn:"));
    expect(warningLogs).toHaveLength(0);
  });
});

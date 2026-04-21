import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import type { GatewayRequestHandlerOptions, PluginRuntime } from "openclaw/plugin-sdk/core";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type {
  OpenClawPluginApi,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginLogger,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { edgeTTS } from "./tts.js";

const JANET_CLIENT_ID = "openclaw-ios";
const JANET_TTS_STREAM_METHOD = "janet.tts_stream.start";
const JANET_TTS_STREAM_ABORT_METHOD = "janet.tts_stream.abort";
const JANET_TTS_STREAM_EVENT = "janet.tts_stream.event";
const JANET_TTS_VOICE = "en-US-MichelleNeural";
const JANET_TTS_LANG = "en-US";
const JANET_TTS_OUTPUT_FORMAT = "riff-24khz-16bit-mono-pcm";
const JANET_TTS_FRAME_BYTES = 4_800;
const JANET_TTS_WAIT_TIMEOUT_MS = 30_000;

type GatewayMethodContext = GatewayRequestHandlerOptions;
type AgentEventListener = Parameters<PluginRuntime["events"]["onAgentEvent"]>[0];
type JanetTtsLogger = { warn: (message: string) => void };

type ActiveJanetTtsStream = {
  streamKey: string;
  sessionKey: string;
  clientTurnId: string;
  connId: string;
  broadcastToConnIds: GatewayMethodContext["context"]["broadcastToConnIds"];
  rawText: string;
  stableOffset: number;
  spokenPrefix: string;
  emittedAudio: boolean;
  closed: boolean;
  queue: Promise<void>;
  timeout: NodeJS.Timeout;
};

function buildStreamKey(sessionKey: string, clientTurnId: string): string {
  return `${sessionKey}::${clientTurnId}`;
}

function readRequiredString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new Error(`${key} is required`);
}

function isJanetClient(ctx: GatewayMethodContext): boolean {
  return ctx.client?.connect?.client?.id === JANET_CLIENT_ID;
}

function findStableBoundary(text: string): number {
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const ch = text[index];
    if (ch === "." || ch === "!" || ch === "?" || ch === "\n") {
      return index + 1;
    }
  }
  return 0;
}

function sanitizeForSpeech(text: string): string {
  let spoken = text;

  spoken = spoken.replace(/```[\s\S]*?```/g, " I'm skipping the code details here. ");
  spoken = spoken.replace(/`[^`]+`/g, " that code ");
  spoken = spoken.replace(/!?\[([^\]]+)\]\(([^)]+)\)/g, "$1");
  spoken = spoken.replace(/https?:\/\/\S+/g, " ");
  spoken = spoken.replace(/\bwww\.[^\s]+/g, " ");

  spoken = spoken
    .replace(/\r/g, "\n")
    .replace(/\*/g, "")
    .replace(/_/g, " ")
    .replace(/~/g, "")
    .replace(/#/g, "")
    .replace(/>/g, "");

  const cleanedLines = spoken
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      if (line.startsWith("|") && line.endsWith("|")) {
        return [];
      }
      if (looksLikeCode(line)) {
        return [];
      }
      if (line.startsWith("- ") || line.startsWith("• ")) {
        return [line.slice(2)];
      }
      return [line];
    });

  spoken = cleanedLines.join(". ");
  spoken = stripEmoji(spoken);
  spoken = spoken.replace(/[^\p{L}\p{N}\s.,!?'-]+/gu, " ");
  spoken = spoken.replace(/[!?.:,;\-_=+*/\\|]{2,}/g, ". ");
  spoken = spoken.replace(/\s+/g, " ").trim();

  return isMostlySymbols(spoken) ? "" : spoken;
}

function stripEmoji(text: string): string {
  return text.replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "");
}

function looksLikeCode(line: string): boolean {
  if (line.length > 80 && line.includes("{") && line.includes("}")) {
    return true;
  }
  if (
    line.includes("func ") ||
    line.includes("let ") ||
    line.includes("var ") ||
    line.includes("=>")
  ) {
    return true;
  }
  let symbolCount = 0;
  for (const ch of line) {
    if ("{}[]();<>/=\\".includes(ch)) {
      symbolCount += 1;
    }
  }
  return line.length > 24 && symbolCount * 4 > line.length;
}

function isMostlySymbols(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return true;
  }
  let letters = 0;
  for (const ch of trimmed) {
    if (/\p{L}/u.test(ch)) {
      letters += 1;
    }
  }
  return letters * 3 < trimmed.length;
}

function parsePcm16Wave(buffer: Buffer): Buffer {
  if (buffer.length < 44) {
    throw new Error("Microsoft Janet TTS returned a truncated WAV buffer");
  }
  const riff = buffer.toString("ascii", 0, 4);
  const wave = buffer.toString("ascii", 8, 12);
  if (riff !== "RIFF" || wave !== "WAVE") {
    throw new Error("Microsoft Janet TTS did not return RIFF/WAVE audio");
  }

  let offset = 12;
  let audioFormat = 0;
  let channelCount = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let pcmData: Buffer | null = null;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > buffer.length) {
      break;
    }

    if (chunkId === "fmt ") {
      audioFormat = buffer.readUInt16LE(chunkStart);
      channelCount = buffer.readUInt16LE(chunkStart + 2);
      sampleRate = buffer.readUInt32LE(chunkStart + 4);
      bitsPerSample = buffer.readUInt16LE(chunkStart + 14);
    } else if (chunkId === "data") {
      pcmData = buffer.subarray(chunkStart, chunkEnd);
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  if (!pcmData) {
    throw new Error("Microsoft Janet TTS WAV payload is missing a data chunk");
  }
  if (audioFormat !== 1 || channelCount !== 1 || sampleRate !== 24_000 || bitsPerSample !== 16) {
    throw new Error(
      `Microsoft Janet TTS expected pcm_s16le mono 24kHz, received format=${audioFormat} channels=${channelCount} sampleRate=${sampleRate} bits=${bitsPerSample}`,
    );
  }

  return pcmData;
}

async function synthesizeJanetSpeech(text: string): Promise<Buffer> {
  const tempRoot = resolvePreferredOpenClawTmpDir();
  mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  const tempDir = mkdtempSync(path.join(tempRoot, "janet-microsoft-tts-stream-"));
  try {
    const outputPath = path.join(tempDir, "speech.wav");
    await edgeTTS({
      text,
      outputPath,
      config: {
        voice: JANET_TTS_VOICE,
        lang: JANET_TTS_LANG,
        outputFormat: JANET_TTS_OUTPUT_FORMAT,
        saveSubtitles: false,
      },
      timeoutMs: JANET_TTS_WAIT_TIMEOUT_MS,
    });
    return parsePcm16Wave(readFileSync(outputPath));
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

class JanetTtsStreamManager {
  private readonly activeStreams = new Map<string, ActiveJanetTtsStream>();
  private unsubscribeAgentEvents: (() => void) | null = null;
  private logger: JanetTtsLogger | null = null;

  start(runtime: PluginRuntime, logger: JanetTtsLogger): void {
    this.logger = logger;
    if (this.unsubscribeAgentEvents) {
      return;
    }
    this.unsubscribeAgentEvents = runtime.events.onAgentEvent(((evt) => {
      void this.handleAgentEvent(evt).catch((error) => {
        this.logger?.warn(
          `janet tts stream agent-event handling failed: ${formatErrorMessage(error)}`,
        );
      });
    }) as AgentEventListener);
  }

  stop(): void {
    this.unsubscribeAgentEvents?.();
    this.unsubscribeAgentEvents = null;
    for (const stream of this.activeStreams.values()) {
      this.closeStream(stream, {
        type: "error",
        error: "Janet TTS stream stopped",
        didEmitAudio: stream.emittedAudio,
      });
    }
    this.activeStreams.clear();
  }

  async startStream(ctx: GatewayMethodContext): Promise<void> {
    if (!isJanetClient(ctx)) {
      ctx.respond(false, undefined, {
        code: "forbidden",
        message: "janet.tts_stream.start is only available to Janet iOS clients",
      });
      return;
    }

    const connId = ctx.client?.connId?.trim();
    if (!connId) {
      ctx.respond(false, undefined, {
        code: "invalid_request",
        message: "janet.tts_stream.start requires a connected Janet gateway session",
      });
      return;
    }

    try {
      const sessionKey = readRequiredString(ctx.params, "sessionKey");
      const clientTurnId = readRequiredString(ctx.params, "clientTurnId");
      const streamKey = buildStreamKey(sessionKey, clientTurnId);

      const existing = this.activeStreams.get(streamKey);
      if (existing) {
        this.closeStream(existing, {
          type: "error",
          error: "superseded by a newer Janet TTS stream",
          didEmitAudio: existing.emittedAudio,
        });
      }

      for (const active of this.activeStreams.values()) {
        if (active.connId === connId || active.sessionKey === sessionKey) {
          this.closeStream(active, {
            type: "error",
            error: "superseded by a newer Janet TTS stream",
            didEmitAudio: active.emittedAudio,
          });
        }
      }

      const timeout = setTimeout(() => {
        const active = this.activeStreams.get(streamKey);
        if (!active) {
          return;
        }
        this.closeStream(active, {
          type: "error",
          error: "Janet TTS stream timed out waiting for assistant text",
          didEmitAudio: active.emittedAudio,
        });
      }, JANET_TTS_WAIT_TIMEOUT_MS);
      timeout.unref?.();

      const stream: ActiveJanetTtsStream = {
        streamKey,
        sessionKey,
        clientTurnId,
        connId,
        broadcastToConnIds: ctx.context.broadcastToConnIds,
        rawText: "",
        stableOffset: 0,
        spokenPrefix: "",
        emittedAudio: false,
        closed: false,
        queue: Promise.resolve(),
        timeout,
      };
      this.activeStreams.set(streamKey, stream);
      this.emitEvent(stream, {
        type: "start",
        audioFormat: {
          encoding: "pcm_s16le",
          sampleRate: 24_000,
          channels: 1,
          frameMs: 100,
        },
      });
      ctx.respond(true, {
        ok: true,
        sessionKey,
        clientTurnId,
      });
    } catch (error) {
      ctx.respond(false, undefined, {
        code: "invalid_request",
        message: formatErrorMessage(error),
      });
    }
  }

  abortStream(ctx: GatewayMethodContext): void {
    const sessionKey =
      typeof ctx.params.sessionKey === "string" ? ctx.params.sessionKey.trim() : "";
    const clientTurnId =
      typeof ctx.params.clientTurnId === "string" ? ctx.params.clientTurnId.trim() : "";
    if (!sessionKey || !clientTurnId) {
      ctx.respond(false, undefined, {
        code: "invalid_request",
        message: "sessionKey and clientTurnId are required",
      });
      return;
    }
    const stream = this.activeStreams.get(buildStreamKey(sessionKey, clientTurnId));
    if (!stream) {
      ctx.respond(true, { ok: true, aborted: false });
      return;
    }
    this.closeStream(stream, {
      type: "error",
      error: "Janet TTS stream aborted",
      didEmitAudio: stream.emittedAudio,
      suppressEvent: true,
    });
    ctx.respond(true, { ok: true, aborted: true });
  }

  private emitEvent(
    stream: ActiveJanetTtsStream,
    payload:
      | {
          type: "start";
          audioFormat: { encoding: string; sampleRate: number; channels: number; frameMs: number };
        }
      | { type: "chunk"; pcmBase64: string; text?: string }
      | { type: "end"; didEmitAudio: boolean; spokenPrefix: string }
      | { type: "error"; error: string; didEmitAudio: boolean },
  ): void {
    stream.broadcastToConnIds(
      JANET_TTS_STREAM_EVENT,
      {
        sessionKey: stream.sessionKey,
        clientTurnId: stream.clientTurnId,
        ...payload,
      },
      new Set([stream.connId]),
      { dropIfSlow: true },
    );
  }

  private closeStream(
    stream: ActiveJanetTtsStream,
    opts:
      | { type: "end" }
      | { type: "error"; error: string; didEmitAudio: boolean; suppressEvent?: boolean },
  ): void {
    if (stream.closed) {
      return;
    }
    stream.closed = true;
    clearTimeout(stream.timeout);
    this.activeStreams.delete(stream.streamKey);
    if (opts.type === "end") {
      this.emitEvent(stream, {
        type: "end",
        didEmitAudio: stream.emittedAudio,
        spokenPrefix: stream.spokenPrefix,
      });
      return;
    }
    if (!opts.suppressEvent) {
      this.emitEvent(stream, {
        type: "error",
        error: opts.error,
        didEmitAudio: opts.didEmitAudio,
      });
    }
  }

  private async handleAgentEvent(evt: {
    runId: string;
    stream: string;
    sessionKey?: string;
    data: Record<string, unknown>;
  }): Promise<void> {
    const sessionKey = typeof evt.sessionKey === "string" ? evt.sessionKey.trim() : "";
    if (!sessionKey) {
      return;
    }
    const stream = [...this.activeStreams.values()].find(
      (active) => active.sessionKey === sessionKey && !active.closed,
    );
    if (!stream) {
      return;
    }

    if (evt.stream === "assistant") {
      this.handleAssistantEvent(stream, evt.data);
      return;
    }

    if (evt.stream === "lifecycle") {
      const phase = typeof evt.data.phase === "string" ? evt.data.phase : "";
      if (phase === "end") {
        const tail = stream.rawText.slice(stream.stableOffset);
        const hasTail = tail.trim().length > 0;
        if (hasTail) {
          this.enqueueSynthesis(stream, tail, { flushTail: true });
        }
        stream.queue = stream.queue.finally(() => {
          if (!stream.closed) {
            this.closeStream(stream, { type: "end" });
          }
        });
      } else if (phase === "error") {
        const errorText =
          typeof evt.data.error === "string" && evt.data.error.trim()
            ? evt.data.error.trim()
            : "Janet TTS source stream failed";
        this.closeStream(stream, {
          type: "error",
          error: errorText,
          didEmitAudio: stream.emittedAudio,
        });
      }
    }
  }

  private handleAssistantEvent(stream: ActiveJanetTtsStream, data: Record<string, unknown>): void {
    const nextText = typeof data.text === "string" ? data.text : undefined;
    const delta = typeof data.delta === "string" ? data.delta : undefined;

    if (typeof nextText === "string") {
      stream.rawText = nextText;
    } else if (typeof delta === "string" && delta) {
      stream.rawText += delta;
    } else {
      return;
    }

    const unsynthesized = stream.rawText.slice(stream.stableOffset);
    const boundary = findStableBoundary(unsynthesized);
    if (boundary <= 0) {
      return;
    }
    const stableText = unsynthesized.slice(0, boundary);
    stream.stableOffset += boundary;
    this.enqueueSynthesis(stream, stableText);
  }

  private enqueueSynthesis(
    stream: ActiveJanetTtsStream,
    sourceText: string,
    opts?: { flushTail?: boolean },
  ): void {
    stream.queue = stream.queue
      .then(async () => {
        if (stream.closed) {
          return;
        }
        const spokenText = sanitizeForSpeech(sourceText);
        if (!spokenText) {
          stream.spokenPrefix += sourceText;
          return;
        }
        const pcm = await synthesizeJanetSpeech(spokenText);
        if (stream.closed) {
          return;
        }
        stream.spokenPrefix += sourceText;
        for (let offset = 0; offset < pcm.length; offset += JANET_TTS_FRAME_BYTES) {
          if (stream.closed) {
            return;
          }
          const chunk = pcm.subarray(offset, Math.min(offset + JANET_TTS_FRAME_BYTES, pcm.length));
          if (chunk.length === 0) {
            continue;
          }
          stream.emittedAudio = true;
          this.emitEvent(stream, {
            type: "chunk",
            pcmBase64: chunk.toString("base64"),
            ...(offset === 0 ? { text: sourceText } : {}),
          });
        }
      })
      .catch((error) => {
        if (stream.closed) {
          return;
        }
        this.logger?.warn(
          `janet tts synthesis failed for ${stream.clientTurnId}: ${formatErrorMessage(error)}`,
        );
        this.closeStream(stream, {
          type: "error",
          error: opts?.flushTail
            ? `Janet TTS final flush failed: ${formatErrorMessage(error)}`
            : `Janet TTS synthesis failed: ${formatErrorMessage(error)}`,
          didEmitAudio: stream.emittedAudio,
        });
      });
  }
}

const janetTtsStreamManager = new JanetTtsStreamManager();

export function createJanetTtsStreamService(
  runtime: PluginRuntime,
  logger: PluginLogger,
): OpenClawPluginService {
  return {
    id: "microsoft-janet-tts-stream",
    start: async (_ctx: OpenClawPluginServiceContext) => {
      janetTtsStreamManager.start(runtime, logger);
    },
    stop: async () => {
      janetTtsStreamManager.stop();
    },
  };
}

export function registerJanetTtsGateway(api: OpenClawPluginApi): void {
  api.registerGatewayMethod(
    JANET_TTS_STREAM_METHOD,
    async (ctx: GatewayRequestHandlerOptions) => {
      await janetTtsStreamManager.startStream(ctx);
    },
    { scope: "operator.write" },
  );

  api.registerGatewayMethod(
    JANET_TTS_STREAM_ABORT_METHOD,
    (ctx: GatewayRequestHandlerOptions) => {
      janetTtsStreamManager.abortStream(ctx);
    },
    { scope: "operator.write" },
  );
}

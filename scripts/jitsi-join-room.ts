import { execFile } from "node:child_process";
import { watch } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  AzureRealtimeAudioSession,
  type RealtimeFunctionTool,
} from "../src/jitsi-bridge/azure-realtime-audio-session.js";
import { loadJitsiBridgeConfig } from "../src/jitsi-bridge/config.js";
import {
  clearPagePlayback,
  joinJitsiRoom,
  pushPcm16AudioToPage,
} from "../src/jitsi-bridge/jitsi-browser.js";
import { buildBridgePrompt } from "../src/jitsi-bridge/prompts.js";
import type { JitsiBridgeRoomRecord } from "../src/jitsi-bridge/types.js";

const execFileAsync = promisify(execFile);
let delegatedCliEntryPath: string | undefined;
const config = loadJitsiBridgeConfig();
const downstream = config.downstream;

function readArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return process.argv[index + 1];
}

const roomUrl = readArg("--url");
const displayName = readArg("--name") || process.env.JITSI_BOT_DISPLAY_NAME || config.displayName;
const roomId = readArg("--room-id") || process.env.JITSI_ROOM_ID;

if (!roomUrl) {
  throw new Error("--url is required");
}

const stateDir = process.env.JITSI_BRIDGE_STATE_DIR || ".artifacts/jitsi-realtime-bridge";
const roomsFile = path.join(stateDir, "rooms.json");
const bridgeLogFile = path.join(stateDir, `${roomId || "room"}-bridge.log`);

async function appendBridgeLog(message: string): Promise<void> {
  try {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.appendFile(bridgeLogFile, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {
    // Best-effort diagnostics only.
  }
}

async function loadRoomRecord(): Promise<JitsiBridgeRoomRecord | undefined> {
  if (!roomId) {
    return undefined;
  }
  try {
    const raw = await fs.readFile(roomsFile, "utf8");
    const parsed = JSON.parse(raw) as { rooms?: JitsiBridgeRoomRecord[] };
    return parsed.rooms?.find((room) => room.id === roomId);
  } catch {
    return undefined;
  }
}

async function updateRoomRecord(
  mutate: (room: JitsiBridgeRoomRecord) => JitsiBridgeRoomRecord,
): Promise<void> {
  if (!roomId) {
    return;
  }
  try {
    const raw = await fs.readFile(roomsFile, "utf8");
    const parsed = JSON.parse(raw) as { rooms?: JitsiBridgeRoomRecord[] };
    const rooms = Array.isArray(parsed.rooms) ? parsed.rooms : [];
    const index = rooms.findIndex((room) => room.id === roomId);
    if (index === -1) {
      return;
    }
    rooms[index] = mutate({
      ...rooms[index],
      updatedAt: new Date().toISOString(),
    });
    await fs.writeFile(roomsFile, `${JSON.stringify({ rooms }, null, 2)}\n`, "utf8");
  } catch {
    // Best-effort status persistence.
  }
}

type OpenclawAgentPayload = {
  payloads?: Array<{
    text?: string;
    mediaUrl?: string | null;
    mediaUrls?: string[];
  }>;
  meta?: unknown;
};

type OpenclawAgentEnvelope = {
  result?: OpenclawAgentPayload;
  payloads?: OpenclawAgentPayload["payloads"];
  meta?: unknown;
};

let delegatedConfigPath: string | undefined;
let delegatedConfigPathResolved = false;
let delegateCallInFlight = false;

const delegationTools: RealtimeFunctionTool[] = [
  {
    type: "function",
    name: downstream.delegation.toolName,
    description: downstream.delegation.toolDescription,
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["message"],
      properties: {
        message: {
          type: "string",
          description: downstream.delegation.toolMessageDescription,
        },
      },
    },
  },
];

function extractOpenclawReply(result: OpenclawAgentEnvelope): string {
  const payloads = Array.isArray(result.payloads)
    ? result.payloads
    : Array.isArray(result.result?.payloads)
      ? result.result?.payloads
      : [];
  const lines: string[] = [];
  for (const payload of payloads) {
    if (typeof payload.text === "string" && payload.text.trim()) {
      lines.push(payload.text.trim());
    }
    if (typeof payload.mediaUrl === "string" && payload.mediaUrl.trim()) {
      lines.push(`MEDIA:${payload.mediaUrl.trim()}`);
    }
    if (Array.isArray(payload.mediaUrls)) {
      for (const mediaUrl of payload.mediaUrls) {
        if (typeof mediaUrl === "string" && mediaUrl.trim()) {
          lines.push(`MEDIA:${mediaUrl.trim()}`);
        }
      }
    }
  }
  return lines.join("\n").trim();
}

function toSpokenReply(raw: string): string {
  let text = raw.trim();
  if (!text) {
    return text;
  }

  // Remove fenced code blocks for cleaner TTS output.
  text = text.replace(/```[\s\S]*?```/g, " ");
  // Remove inline code markers.
  text = text.replace(/`([^`]+)`/g, "$1");
  // Collapse markdown list markers/headings.
  text = text.replace(/^[#*\-\d.\s]+/gm, "");
  // Reduce long URLs in spoken output.
  text = text.replace(/https?:\/\/\S+/g, "Link");
  // Normalize whitespace.
  text = text.replace(/\s+/g, " ").trim();

  // Keep spoken replies concise to avoid rambling.
  if (text.length > 420) {
    text = `${text.slice(0, 417).trimEnd()}...`;
  }
  return text;
}

async function runDelegatedOpenclawAgent(message: string): Promise<string> {
  const prompt = message.trim();
  if (!prompt) {
    throw new Error(`${downstream.delegation.toolName} requires non-empty message`);
  }
  if (!delegatedConfigPathResolved) {
    delegatedConfigPath = await prepareDelegatedConfigPath();
    delegatedConfigPathResolved = true;
  }
  const childEnv = delegatedConfigPath
    ? {
        ...process.env,
        OPENCLAW_CONFIG_PATH: delegatedConfigPath,
        CLAWDBOT_CONFIG_PATH: delegatedConfigPath,
      }
    : process.env;

  const delegationSessionId = `jitsi-delegation-${(roomId || "default").replace(/[^a-zA-Z0-9._-]/g, "-")}`;

  if (!delegatedCliEntryPath) {
    delegatedCliEntryPath = await resolveDelegatedCliEntryPath();
  }

  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [
      delegatedCliEntryPath,
      "agent",
      "--local",
      "--session-id",
      delegationSessionId,
      "--message",
      prompt,
      "--json",
    ],
    {
      cwd: process.cwd(),
      env: childEnv,
      timeout: 60_000,
      killSignal: "SIGKILL",
      maxBuffer: 8 * 1024 * 1024,
    },
  );

  let parsed: OpenclawAgentEnvelope | null = null;
  const trimmed = stdout.trim();
  if (trimmed) {
    try {
      parsed = JSON.parse(trimmed) as OpenclawAgentEnvelope;
    } catch {
      // Fallback: extract JSON object from mixed log+JSON output.
      const firstBrace = trimmed.indexOf("{");
      const lastBrace = trimmed.lastIndexOf("}");
      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        const candidate = trimmed.slice(firstBrace, lastBrace + 1);
        try {
          parsed = JSON.parse(candidate) as OpenclawAgentEnvelope;
        } catch {
          // Continue with line-wise fallback below.
        }
      }
      // Secondary fallback: try last JSON object line if additional logs were emitted.
      const lines = trimmed
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          parsed = JSON.parse(lines[i]) as OpenclawAgentEnvelope;
          break;
        } catch {
          // Keep scanning backward.
        }
      }
    }
  }

  if (!parsed) {
    const diagnostic = [trimmed, stderr.trim()].filter(Boolean).join("\n");
    throw new Error(
      `openclaw agent produced no parseable JSON output: ${diagnostic.slice(0, 600)}`,
    );
  }

  const reply = extractOpenclawReply(parsed);
  if (!reply) {
    return downstream.delegation.emptyReply;
  }
  return toSpokenReply(reply);
}

async function resolveDelegatedCliEntryPath(): Promise<string> {
  const fromEnv = process.env.OPENCLAW_DELEGATE_ENTRY?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  const home = process.env.HOME?.trim();
  if (home) {
    const globalEntry = path.join(
      home,
      ".npm-global",
      "lib",
      "node_modules",
      "openclaw",
      "dist",
      "entry.js",
    );
    try {
      await fs.access(globalEntry);
      return globalEntry;
    } catch {
      // Continue to local fallback.
    }
  }
  return path.join(process.cwd(), "openclaw.mjs");
}

async function prepareDelegatedConfigPath(): Promise<string | undefined> {
  const configuredPath =
    process.env.OPENCLAW_CONFIG_PATH ||
    process.env.CLAWDBOT_CONFIG_PATH ||
    (process.env.HOME ? path.join(process.env.HOME, ".openclaw", "openclaw.json") : undefined);
  if (!configuredPath) {
    return undefined;
  }

  try {
    const raw = await fs.readFile(configuredPath, "utf8");
    const parsed = JSON.parse(raw) as {
      channels?: {
        telegram?: Record<string, unknown>;
      };
    };
    const telegram = parsed.channels?.telegram;
    if (!telegram || !Object.prototype.hasOwnProperty.call(telegram, "jitsi")) {
      return undefined;
    }

    const sanitized: Record<string, unknown> = { ...parsed };
    const channels =
      typeof sanitized.channels === "object" && sanitized.channels !== null
        ? ({ ...(sanitized.channels as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    const telegramSanitized = { ...telegram };
    delete telegramSanitized.jitsi;
    channels.telegram = telegramSanitized;
    sanitized.channels = channels;

    await fs.mkdir(stateDir, { recursive: true });
    const target = path.join(stateDir, "openclaw-delegation.config.json");
    await fs.writeFile(target, `${JSON.stringify(sanitized, null, 2)}\n`, "utf8");
    await appendBridgeLog(`delegate config sanitized: ${target}`);
    return target;
  } catch (error) {
    await appendBridgeLog(
      `delegate config sanitize skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

let currentInstructions = buildBridgePrompt({
  roomId: roomId || "jitsi-room",
  briefing: (await loadRoomRecord())?.briefing || process.env.JITSI_BRIEFING || "",
  promptConfig: downstream.prompt,
});

const roomRecord = await loadRoomRecord();
await appendBridgeLog(
  `joiner starting roomId=${roomId || "n/a"} model=${roomRecord?.realtimeModel || process.env.JITSI_REALTIME_MODEL || config.realtimeModel}`,
);
const audioSession = new AzureRealtimeAudioSession({
  baseUrl: config.realtimeBaseUrl,
  apiKey: config.realtimeApiKey,
  model: roomRecord?.realtimeModel || process.env.JITSI_REALTIME_MODEL || config.realtimeModel,
  instructions: currentInstructions,
  tools: delegationTools,
  onToolCall: async ({ name, argumentsJson }) => {
    if (name !== downstream.delegation.toolName) {
      throw new Error(`Unsupported tool ${name}`);
    }
    let parsed: { message?: unknown } = {};
    try {
      parsed = JSON.parse(argumentsJson || "{}") as { message?: unknown };
    } catch {
      parsed = { message: argumentsJson };
    }
    const message = typeof parsed.message === "string" ? parsed.message : "";
    if (delegateCallInFlight) {
      await appendBridgeLog(`delegate tool skipped (in-flight): ${message.slice(0, 220)}`);
      return {
        reply: downstream.delegation.inFlightReply,
      };
    }
    delegateCallInFlight = true;
    await appendBridgeLog(`delegate tool call: ${message.slice(0, 220)}`);
    try {
      const delegatedReply = await runDelegatedOpenclawAgent(message);
      await appendBridgeLog(`delegate tool done: ${delegatedReply.slice(0, 220)}`);
      return {
        reply: delegatedReply,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await appendBridgeLog(`delegate tool error: ${detail.slice(0, 300)}`);
      throw error;
    } finally {
      delegateCallInFlight = false;
    }
  },
});

await audioSession.connect();
await appendBridgeLog("azure realtime connected");

const watcher = roomId
  ? watch(roomsFile, async () => {
      const latest = await loadRoomRecord();
      if (!latest) {
        return;
      }
      const nextInstructions = buildBridgePrompt({
        roomId: latest.id,
        briefing: latest.briefing,
        promptConfig: downstream.prompt,
      });
      if (nextInstructions !== currentInstructions) {
        currentInstructions = nextInstructions;
        audioSession.updateInstructions(nextInstructions);
      }
    })
  : null;

try {
  let inputChunks = 0;
  let outputChunks = 0;
  let pageBound = false;
  await joinJitsiRoom({
    roomUrl,
    displayName,
    headless: process.env.JITSI_JOIN_HEADLESS !== "0",
    stateDir,
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    onCapturedAudioChunk: async (audioBase64, sampleRate) => {
      inputChunks += 1;
      if (inputChunks % 40 === 0) {
        await appendBridgeLog(`input audio chunks=${inputChunks} sampleRate=${sampleRate}`);
      }
      audioSession.appendInputAudio(audioBase64, sampleRate);
    },
    onPageReady: async (page) => {
      if (pageBound) {
        return;
      }
      pageBound = true;
      await appendBridgeLog("page ready; room joined");
      await updateRoomRecord((room) => ({
        ...room,
        status: "joined",
        lastJoinPid: process.pid,
        lastError: undefined,
      }));
      audioSession.setCallbacks({
        onOutputAudioDelta: (audioBase64: string) => {
          outputChunks += 1;
          void appendBridgeLog(
            `output audio chunk=${outputChunks} bytes(base64)=${audioBase64.length}`,
          );
          void pushPcm16AudioToPage(page, audioBase64).catch(() => {});
        },
        onOutputTranscriptDelta: (text: string) => {
          const normalized = text.replace(/\s+/g, " ").trim();
          if (normalized) {
            void appendBridgeLog(`transcript: ${normalized.slice(0, 220)}`);
          }
        },
        onSpeechStarted: () => {
          void appendBridgeLog("vad: speech started");
          void clearPagePlayback(page).catch(() => {});
        },
        onError: (error: Error) => {
          void appendBridgeLog(`azure error: ${error.message}`);
          console.error(error.message);
        },
      });
      audioSession.updateInstructions(currentInstructions);
    },
  });
} catch (error) {
  await appendBridgeLog(`joiner error: ${error instanceof Error ? error.message : String(error)}`);
  await updateRoomRecord((room) => ({
    ...room,
    status: "error",
    lastError: error instanceof Error ? error.message : String(error),
  }));
  throw error;
} finally {
  await appendBridgeLog("joiner shutting down");
  watcher?.close();
  audioSession.close();
}

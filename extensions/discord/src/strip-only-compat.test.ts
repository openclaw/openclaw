import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

type StripOnlyTarget = {
  entryPath: string;
  sandboxEntryPath: string;
  stubFiles: Record<string, string>;
};

const RUNTIME_LOCAL_IMPORT_RE =
  /\b(?:import|export)\s+(?!type\b)(?:[\s\S]*?\s+from\s*)?["'](\.{1,2}\/[^"']+)["']/g;

const SHARED_STUB_FILES = {
  "package.json": JSON.stringify({ type: "module" }),
  "internal/discord.js": `
export const ChannelType = { GuildVoice: 2, GuildStageVoice: 3 };
class BaseListener {
  type = this.constructor.name;
}
export class InteractionCreateListener extends BaseListener {}
export class MessageCreateListener extends BaseListener {}
export class MessageReactionAddListener extends BaseListener {}
export class MessageReactionRemoveListener extends BaseListener {}
export class PresenceUpdateListener extends BaseListener {}
export class ReadyListener extends BaseListener {}
export class ResumedListener extends BaseListener {}
export class ThreadUpdateListener extends BaseListener {}
`,
  "node_modules/@buape/carbon/package.json": JSON.stringify({
    name: "@buape/carbon",
    type: "module",
    exports: {
      ".": "./index.js",
      "./voice": "./voice/index.js",
    },
  }),
  "node_modules/@buape/carbon/index.js": `
export const ChannelType = { GuildVoice: 2, GuildStageVoice: 3 };
export class MessageCreateListener {}
export class MessageReactionAddListener {}
export class MessageReactionRemoveListener {}
export class PresenceUpdateListener {}
export class ReadyListener {}
export class ThreadUpdateListener {}
`,
  "node_modules/@buape/carbon/voice/index.js": `
export class VoicePlugin {}
`,
  "node_modules/openclaw/package.json": JSON.stringify({
    name: "openclaw",
    type: "module",
    exports: {
      "./plugin-sdk/agent-runtime": "./plugin-sdk/agent-runtime.js",
      "./plugin-sdk/config-runtime": "./plugin-sdk/config-runtime.js",
      "./plugin-sdk/config-types": "./plugin-sdk/config-types.js",
      "./plugin-sdk/infra-runtime": "./plugin-sdk/infra-runtime.js",
      "./plugin-sdk/media-understanding-runtime": "./plugin-sdk/media-understanding-runtime.js",
      "./plugin-sdk/routing": "./plugin-sdk/routing.js",
      "./plugin-sdk/runtime-env": "./plugin-sdk/runtime-env.js",
      "./plugin-sdk/security-runtime": "./plugin-sdk/security-runtime.js",
      "./plugin-sdk/ssrf-runtime": "./plugin-sdk/ssrf-runtime.js",
      "./plugin-sdk/speech": "./plugin-sdk/speech.js",
      "./plugin-sdk/speech-runtime": "./plugin-sdk/speech-runtime.js",
      "./plugin-sdk/system-event-runtime": "./plugin-sdk/system-event-runtime.js",
    },
  }),
  "node_modules/openclaw/plugin-sdk/agent-runtime.js": `
export function resolveAgentDir() { return "/tmp"; }
export function agentCommandFromIngress() { return {}; }
export function resolveTtsConfig() { return {}; }
`,
  "node_modules/openclaw/plugin-sdk/config-runtime.js": `
export function loadConfig() { return {}; }
export function isDangerousNameMatchingEnabled() { return false; }
`,
  "node_modules/openclaw/plugin-sdk/config-types.js": `
export {};
`,
  "node_modules/openclaw/plugin-sdk/infra-runtime.js": `
export function enqueueSystemEvent() {}
export function formatDurationSeconds() { return "0s"; }
export function formatErrorMessage(err) { return String(err); }
export function resolvePreferredOpenClawTmpDir() { return "/tmp"; }
`,
  "node_modules/openclaw/plugin-sdk/media-understanding-runtime.js": `
export async function transcribeAudioFile() { return { text: "" }; }
`,
  "node_modules/openclaw/plugin-sdk/routing.js": `
export function resolveAgentRoute() { return {}; }
`,
  "node_modules/openclaw/plugin-sdk/runtime-env.js": `
export function danger(value) { return value; }
export function logVerbose() {}
export function shouldLogVerbose() { return false; }
export function createSubsystemLogger() {
  return { warn() {}, error() {}, info() {}, debug() {} };
}
`,
  "node_modules/openclaw/plugin-sdk/security-runtime.js": `
export function readStoreAllowFromForDmPolicy() { return false; }
export function resolveDmGroupAccessWithLists() { return {}; }
`,
  "node_modules/openclaw/plugin-sdk/ssrf-runtime.js": `
export function formatErrorMessage(err) { return String(err); }
`,
  "node_modules/openclaw/plugin-sdk/speech.js": `
export function parseTtsDirectives() { return { text: "" }; }
`,
  "node_modules/openclaw/plugin-sdk/speech-runtime.js": `
export async function textToSpeech() { return new Uint8Array(); }
`,
  "node_modules/openclaw/plugin-sdk/system-event-runtime.js": `
export function enqueueSystemEvent() {}
`,
} satisfies Record<string, string>;

const STRIP_ONLY_TARGETS: StripOnlyTarget[] = [
  {
    entryPath: "extensions/discord/src/monitor/listeners.ts",
    sandboxEntryPath: "monitor/listeners.ts",
    stubFiles: {
      "monitor/listeners.queue.js": `
export const discordEventQueueLog = { warn() {}, error() {}, info() {}, debug() {} };
export async function runDiscordListenerWithSlowLog(params) { await params.run(); }
`,
      "monitor/listeners.reactions.js": `
export class DiscordReactionListener {}
export class DiscordReactionRemoveListener {}
`,
      "monitor/presence-cache.js": `
export function setPresence() {}
`,
      "monitor/thread-bindings.discord-api.js": `
export function isThreadArchived() { return false; }
`,
      "monitor/thread-session-close.js": `
export async function closeDiscordThreadSessions() {}
`,
      "monitor/timeouts.js": `
export function normalizeDiscordListenerTimeoutMs() { return 0; }
export async function runDiscordTaskWithTimeout() { return false; }
`,
    },
  },
  {
    entryPath: "extensions/discord/src/monitor/listeners.reactions.ts",
    sandboxEntryPath: "monitor/listeners.reactions.ts",
    stubFiles: {
      "monitor/allow-list.js": `
export function isDiscordGroupAllowedByPolicy() { return false; }
export function normalizeDiscordAllowList(value) { return value; }
export function normalizeDiscordSlug(value) { return value; }
export function resolveDiscordAllowListMatch() { return { allowed: false }; }
export function resolveDiscordChannelConfigWithFallback() { return {}; }
export function resolveDiscordGuildEntry() { return null; }
export function resolveDiscordMemberAccessState() { return {}; }
export function resolveGroupDmAllow() { return false; }
export function shouldEmitDiscordReactionNotification() { return false; }
`,
      "monitor/format.js": `
export function formatDiscordReactionEmoji() { return ""; }
export function formatDiscordUserTag() { return ""; }
`,
      "monitor/listeners.queue.js": `
export async function runDiscordListenerWithSlowLog(params) { await params.run(); }
`,
      "monitor/thread-channel-context.js": `
export async function resolveFetchedDiscordThreadLikeChannelContext() { return {}; }
`,
    },
  },
  {
    entryPath: "extensions/discord/src/voice/manager.ts",
    sandboxEntryPath: "voice/manager.ts",
    stubFiles: {
      "accounts.js": `
export function resolveDiscordAccountAllowFrom() { return undefined; }
`,
      "mentions.js": `
export function formatMention() { return ""; }
`,
      "voice/audio.js": `
export function decodeOpusStream() { return null; }
export function writeVoiceWavFile() {}
`,
      "voice/capture-state.js": `
export function beginVoiceCapture() {}
export function clearVoiceCaptureFinalizeTimer() {}
export function createVoiceCaptureState() { return {}; }
export function finishVoiceCapture() {}
export function getActiveVoiceCapture() { return null; }
export function isVoiceCaptureActive() { return false; }
export function scheduleVoiceCaptureFinalize() {}
export function stopVoiceCaptureState() {}
`,
      "voice/config.js": `
export function resolveDiscordVoiceEnabled() { return false; }
`,
      "voice/receive-recovery.js": `
export const DAVE_RECEIVE_PASSTHROUGH_INITIAL_EXPIRY_SECONDS = 0;
export const DAVE_RECEIVE_PASSTHROUGH_REARM_EXPIRY_SECONDS = 0;
export function analyzeVoiceReceiveError() { return {}; }
export function createVoiceReceiveRecoveryState() { return {}; }
export function enableDaveReceivePassthrough() { return false; }
export function finishVoiceDecryptRecovery() {}
export function noteVoiceDecryptFailure() {}
export function resetVoiceReceiveRecoveryState() {}
`,
      "voice/sdk-runtime.js": `
export function loadDiscordVoiceSdk() {
  return {
    getVoiceConnection() { return null; },
    joinVoiceChannel() { return {}; },
    createAudioPlayer() { return {}; },
    createAudioResource() { return {}; },
    NoSubscriberBehavior: { Play: "play" },
    AudioPlayerStatus: { Idle: "idle", Playing: "playing" },
    VoiceConnectionStatus: { Ready: "ready", Destroyed: "destroyed" },
    entersState() { return Promise.resolve(); },
    EndBehaviorType: { AfterSilence: "after" },
  };
}
`,
      "voice/segment.js": `
export async function processDiscordVoiceSegment() {}
`,
      "voice/session.js": `
export const CAPTURE_FINALIZE_GRACE_MS = 0;
export const MIN_SEGMENT_SECONDS = 0;
export const VOICE_CONNECT_READY_TIMEOUT_MS = 0;
export const VOICE_RECONNECT_GRACE_MS = 0;
export function isVoiceChannel() { return true; }
export function logVoiceVerbose() {}
export function resolveVoiceTimeoutMs(value, fallback) { return value ?? fallback; }
`,
      "voice/speaker-context.js": `
export class DiscordVoiceSpeakerContextResolver {
  constructor() {}
}
`,
    },
  },
];

function writeSandboxFile(sandboxRoot: string, relativePath: string, content: string) {
  const filePath = path.join(sandboxRoot, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function runtimeLocalImportsForTarget(target: StripOnlyTarget): string[] {
  const source = readFileSync(path.resolve(process.cwd(), target.entryPath), "utf8");
  const importedPaths = new Set<string>();
  for (const match of source.matchAll(RUNTIME_LOCAL_IMPORT_RE)) {
    const specifier = match[1];
    if (!specifier) {
      continue;
    }
    const importedPath = path
      .normalize(path.join(path.dirname(target.sandboxEntryPath), specifier))
      .replaceAll(path.sep, "/");
    importedPaths.add(importedPath);
  }
  return Array.from(importedPaths).toSorted();
}

function assertCompleteLocalRuntimeFiles(target: StripOnlyTarget) {
  const sandboxFiles = new Set([
    ...Object.keys(SHARED_STUB_FILES),
    ...Object.keys(target.stubFiles),
    target.sandboxEntryPath,
  ]);
  const missing = runtimeLocalImportsForTarget(target).filter(
    (importedPath) => !sandboxFiles.has(importedPath),
  );
  expect(missing).toEqual([]);
}

function runStripOnlyTarget(target: StripOnlyTarget) {
  assertCompleteLocalRuntimeFiles(target);
  const sandboxRoot = mkdtempSync(path.join(os.tmpdir(), "openclaw-discord-strip-only-"));
  try {
    for (const [relativePath, content] of Object.entries(SHARED_STUB_FILES)) {
      writeSandboxFile(sandboxRoot, relativePath, content);
    }
    for (const [relativePath, content] of Object.entries(target.stubFiles)) {
      writeSandboxFile(sandboxRoot, relativePath, content);
    }

    const sandboxEntryPath = path.join(sandboxRoot, target.sandboxEntryPath);
    mkdirSync(path.dirname(sandboxEntryPath), { recursive: true });
    copyFileSync(path.resolve(process.cwd(), target.entryPath), sandboxEntryPath);

    return spawnSync(process.execPath, ["--experimental-strip-types", sandboxEntryPath], {
      cwd: sandboxRoot,
      encoding: "utf8",
    });
  } finally {
    rmSync(sandboxRoot, { force: true, recursive: true });
  }
}

describe("Discord strip-only compatibility", () => {
  it.each(STRIP_ONLY_TARGETS.map((target) => [target.entryPath, target] as const))(
    "executes %s under Node strip-only mode",
    (_entryPath, target) => {
      const result = runStripOnlyTarget(target);

      expect(result.status, result.stderr).toBe(0);
    },
  );
});

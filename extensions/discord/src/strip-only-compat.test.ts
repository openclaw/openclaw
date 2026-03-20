import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

type StripOnlyTarget = {
  entryPath: string;
  sandboxEntryPath: string;
  stubFiles: Record<string, string>;
};

const SHARED_STUB_FILES = {
  "package.json": JSON.stringify({ type: "module" }),
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
      "./plugin-sdk/infra-runtime": "./plugin-sdk/infra-runtime.js",
      "./plugin-sdk/media-understanding-runtime": "./plugin-sdk/media-understanding-runtime.js",
      "./plugin-sdk/routing": "./plugin-sdk/routing.js",
      "./plugin-sdk/runtime-env": "./plugin-sdk/runtime-env.js",
      "./plugin-sdk/security-runtime": "./plugin-sdk/security-runtime.js",
      "./plugin-sdk/speech": "./plugin-sdk/speech.js",
      "./plugin-sdk/speech-runtime": "./plugin-sdk/speech-runtime.js",
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
  "node_modules/openclaw/plugin-sdk/speech.js": `
export function parseTtsDirectives() { return { text: "" }; }
`,
  "node_modules/openclaw/plugin-sdk/speech-runtime.js": `
export async function textToSpeech() { return new Uint8Array(); }
`,
} satisfies Record<string, string>;

const STRIP_ONLY_TARGETS: StripOnlyTarget[] = [
  {
    entryPath: "extensions/discord/src/monitor/listeners.ts",
    sandboxEntryPath: "monitor/listeners.ts",
    stubFiles: {
      "monitor/allow-list.js": `
export function isDiscordGroupAllowedByPolicy() { return false; }
export function normalizeDiscordAllowList(value) { return value; }
export function normalizeDiscordSlug(value) { return value; }
export function resolveDiscordAllowListMatch() { return false; }
export function resolveDiscordChannelConfigWithFallback() { return {}; }
export function resolveDiscordMemberAccessState() { return {}; }
export function resolveGroupDmAllow() { return false; }
export function resolveDiscordGuildEntry() { return {}; }
export function shouldEmitDiscordReactionNotification() { return false; }
`,
      "monitor/format.js": `
export function formatDiscordReactionEmoji() { return ""; }
export function formatDiscordUserTag() { return ""; }
`,
      "monitor/message-utils.js": `
export function resolveDiscordChannelInfo() { return {}; }
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
    entryPath: "extensions/discord/src/voice/manager.ts",
    sandboxEntryPath: "voice/manager.ts",
    stubFiles: {
      "mentions.js": `
export function formatMention() { return ""; }
`,
      "monitor/allow-list.js": `
export function resolveDiscordOwnerAccess() { return {}; }
`,
      "monitor/format.js": `
export function formatDiscordUserTag() { return ""; }
`,
      "voice/sdk-runtime.js": `
export async function loadDiscordVoiceSdk() {
  return {
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
    },
  },
];

function writeSandboxFile(sandboxRoot: string, relativePath: string, content: string) {
  const filePath = path.join(sandboxRoot, relativePath);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, content);
}

function runStripOnlyTarget(target: StripOnlyTarget) {
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

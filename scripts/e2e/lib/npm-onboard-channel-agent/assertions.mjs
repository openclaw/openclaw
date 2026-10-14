// Assertions for npm onboard channel-agent E2E scenarios.
import fs from "node:fs";
import path from "node:path";
import {
  assertAgentReplyContainsMarker,
  assertOpenAiRequestLogUsed,
} from "../agent-turn-output.mjs";
import {
  assertNoLegacyPrimaryAuthRows,
  assertOpenAiEnvAuthProfileStore,
  readCanonicalAuthProfileStoreText,
} from "../auth-profile-store-assertions.mjs";
import { readPositiveIntEnv } from "../env-limits.mjs";
import {
  applyMockOpenAiModelConfig,
  parseMockOpenAiPort,
} from "../fixtures/mock-openai-config.mjs";
import { readTextFileBounded, readTextFileTail } from "../text-file-utils.mjs";

const command = process.argv[2];
const ERROR_DETAIL_TAIL_BYTES = 16 * 1024;
const JSON_ARTIFACT_MAX_BYTES = readPositiveIntEnv(
  "OPENCLAW_NPM_ONBOARD_JSON_ARTIFACT_MAX_BYTES",
  1024 * 1024,
);
const STATUS_TEXT_MAX_BYTES = readPositiveIntEnv(
  "OPENCLAW_NPM_ONBOARD_STATUS_TEXT_MAX_BYTES",
  1024 * 1024,
);
const ansiEscapePattern = new RegExp(String.raw`\u001b\[[0-?]*[ -/]*[@-~]`, "g");

function readJson(file) {
  return JSON.parse(
    readTextFileBounded(file, "JSON artifact", JSON_ARTIFACT_MAX_BYTES, {
      tailBytes: ERROR_DETAIL_TAIL_BYTES,
    }),
  );
}

function stripAnsi(text) {
  return text.replace(ansiEscapePattern, "");
}

const statusSectionTitles = new Set([
  "openclaw status",
  "overview",
  "plugin compatibility",
  "model selection",
  "security audit",
  "channels",
  "sessions",
  "system events",
  "health",
  "usage",
]);

function normalizedStatusHeading(line) {
  return stripAnsi(line)
    .trim()
    .replace(/^#+\s*/, "")
    .trim()
    .toLowerCase();
}

function extractStatusSection(text, title) {
  const target = title.toLowerCase();
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => normalizedStatusHeading(line) === target);
  if (start === -1) {
    return null;
  }
  const section = [];
  for (const line of lines.slice(start + 1)) {
    const normalized = normalizedStatusHeading(line);
    if (normalized && statusSectionTitles.has(normalized)) {
      break;
    }
    section.push(line);
  }
  return stripAnsi(section.join("\n"));
}

function assertOnboardState() {
  const home = process.argv[3];
  const stateDir = path.join(home, ".openclaw");
  const configPath = path.join(stateDir, "openclaw.json");

  if (!fs.existsSync(configPath)) {
    throw new Error("onboard did not write openclaw.json");
  }
  assertNoLegacyPrimaryAuthRows(stateDir);
  const authStoreText = readCanonicalAuthProfileStoreText(stateDir);
  if (!authStoreText) {
    throw new Error("onboard did not persist auth profile store");
  }
  assertOpenAiEnvAuthProfileStore(authStoreText, {
    envRefMessage: "auth profile did not persist OPENAI_API_KEY env ref",
    rawKeyMessage: "auth profile persisted the raw OpenAI test key",
    rawKeyNeedle: "sk-openclaw-npm-onboard-e2e",
  });
}

function configureMockModel() {
  const mockPort = parseMockOpenAiPort(process.argv[3]);
  const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
  const cfg = readJson(configPath);
  applyMockOpenAiModelConfig(cfg, { mockPort });
  fs.writeFileSync(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
}

function assertMockModelConfig() {
  const mockPort = parseMockOpenAiPort(process.argv[3]);
  const expectedModelRef = "openai/gpt-5.6-luna";
  const expectedBaseUrl = `http://127.0.0.1:${mockPort}/v1`;
  const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
  const cfg = readJson(configPath);
  const provider = cfg.models?.providers?.openai;
  if (provider?.baseUrl !== expectedBaseUrl) {
    throw new Error(
      `mock OpenAI baseUrl was not preserved; expected ${expectedBaseUrl}, got ${provider?.baseUrl}`,
    );
  }
  if (provider?.api !== "openai-responses") {
    throw new Error(`mock OpenAI api was not preserved; got ${provider?.api}`);
  }
  if (provider?.agentRuntime?.id !== "openclaw") {
    throw new Error(`mock OpenAI runtime was not preserved; got ${provider?.agentRuntime?.id}`);
  }
  for (const [label, agent] of [
    ["default", cfg.agents?.defaults],
    ["agent", cfg.agents?.entries?.main],
  ]) {
    const model = agent?.model?.primary;
    const runtime = agent?.models?.[expectedModelRef]?.agentRuntime?.id;
    if (model !== expectedModelRef) {
      throw new Error(
        `mock ${label} model was not preserved; expected ${expectedModelRef}, got ${model}`,
      );
    }
    if (runtime !== "openclaw") {
      throw new Error(`mock ${label} runtime was not preserved; got ${runtime}`);
    }
  }
}

function assertChannelConfig() {
  const channel = process.argv[3];
  const expectedTokens = process.argv.slice(4);
  const configPath = path.join(process.env.HOME, ".openclaw", "openclaw.json");
  const cfg = readJson(configPath);
  const entry = cfg.channels?.[channel];
  if (!entry || entry.enabled === false) {
    throw new Error(`${channel} was not enabled`);
  }
  const tokenFields = new Map([
    ["telegram", ["botToken"]],
    ["discord", ["token"]],
    ["slack", ["botToken", "appToken"]],
  ]).get(channel);
  if (!tokenFields) {
    throw new Error(`unsupported channel config assertion: ${channel}`);
  }
  if (expectedTokens.length !== tokenFields.length) {
    throw new Error(
      `${channel} channel config assertion requires ${channel === "slack" ? "bot and app tokens" : "one bot token"}`,
    );
  }
  for (const [index, field] of tokenFields.entries()) {
    const expected = expectedTokens[index];
    if (entry[field] !== expected) {
      throw new Error(
        `${channel} config did not persist ${field}; expected ${expected}, got ${JSON.stringify(entry[field])}`,
      );
    }
  }
}

function assertStatusSurfaces() {
  const channel = process.argv[3];
  const channelsStatusPath = process.argv[4];
  const statusTextPath = process.argv[5];
  const channelsStatus = readJson(channelsStatusPath);
  const statusText = readTextFileBounded(
    statusTextPath,
    "plain status output",
    STATUS_TEXT_MAX_BYTES,
    { tailBytes: ERROR_DETAIL_TAIL_BYTES },
  );
  const statusTail = readTextFileTail(statusTextPath, ERROR_DETAIL_TAIL_BYTES);
  const configuredChannels = Array.isArray(channelsStatus.configuredChannels)
    ? channelsStatus.configuredChannels
    : [];
  if (!configuredChannels.includes(channel)) {
    throw new Error(
      `channels status did not list configured channel ${channel}. Payload: ${JSON.stringify(channelsStatus)}`,
    );
  }
  if (!/channels/i.test(statusText)) {
    throw new Error(
      `plain status output did not render a Channels section. Output tail: ${statusTail}`,
    );
  }
  const channelsSection = extractStatusSection(statusText, "channels");
  if (!channelsSection) {
    throw new Error(
      `plain status output did not render a Channels section. Output tail: ${statusTail}`,
    );
  }
  if (!channelsSection.toLowerCase().includes(channel.toLowerCase())) {
    throw new Error(
      `plain status output did not mention ${channel} in the Channels section. Output tail: ${statusTail}`,
    );
  }
}

function assertAgentTurn() {
  const marker = process.argv[3];
  const logPath = process.argv[4];
  assertAgentReplyContainsMarker(marker, "/tmp/openclaw-agent.combined");
  assertOpenAiRequestLogUsed(logPath);
}

const commands = {
  "assert-onboard-state": assertOnboardState,
  "configure-mock-model": configureMockModel,
  "assert-mock-model-config": assertMockModelConfig,
  "assert-channel-config": assertChannelConfig,
  "assert-status-surfaces": assertStatusSurfaces,
  "assert-agent-turn": assertAgentTurn,
};

const fn = commands[command];
if (!fn) {
  throw new Error(`unknown npm onboard/channel/agent assertion command: ${command}`);
}
fn();

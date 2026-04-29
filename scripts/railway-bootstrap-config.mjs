#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const DEFAULT_TEMPLATE_CONFIG_PATH = join(REPO_ROOT, "railway.openclaw.config.json");
const DEFAULT_PERSONA_TEMPLATE_PATH = join(
  REPO_ROOT,
  "deploy",
  "railway",
  "workspaces",
  "discord-jester",
  "AGENTS.md",
);
const DEFAULT_DISCORD_AGENT_ID = "discord-jester";
const DEFAULT_DISCORD_AGENT_NAME = "Grumbleghast";

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseCsvEnv(value) {
  if (typeof value !== "string") {
    return [];
  }
  const seen = new Set();
  const entries = [];
  for (const rawPart of value.split(",")) {
    const part = rawPart.trim();
    if (!part || seen.has(part)) {
      continue;
    }
    seen.add(part);
    entries.push(part);
  }
  return entries;
}

function parseBooleanEnv(value, fallback) {
  if (typeof value !== "string" || value.trim() === "") {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJsonFile(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function ensureObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function findAgent(config, agentId = DEFAULT_DISCORD_AGENT_ID) {
  return ensureArray(config?.agents?.list).find((entry) => entry?.id === agentId) ?? null;
}

export function buildRailwayBootstrapConfig(params = {}) {
  const env = params.env ?? process.env;
  const baseConfig = cloneJson(params.baseConfig ?? readJsonFile(DEFAULT_TEMPLATE_CONFIG_PATH));
  const nextConfig = baseConfig;
  const guildId = env.OPENCLAW_DISCORD_GUILD_ID?.trim();
  const allowedUserIds = parseCsvEnv(env.OPENCLAW_DISCORD_ALLOWED_USER_IDS);
  const allowedChannelIds = parseCsvEnv(env.OPENCLAW_DISCORD_CHANNEL_IDS);
  const requireMention = parseBooleanEnv(env.OPENCLAW_DISCORD_REQUIRE_MENTION, false);
  const automaticGroupReplies = parseBooleanEnv(
    env.OPENCLAW_DISCORD_AUTOMATIC_GROUP_REPLIES,
    true,
  );
  const discordTokenEnv = env.OPENCLAW_DISCORD_TOKEN_ENV?.trim() || "DISCORD_BOT_TOKEN";
  const discordAgentName = env.OPENCLAW_DISCORD_AGENT_NAME?.trim() || DEFAULT_DISCORD_AGENT_NAME;

  const agent = findAgent(nextConfig);
  if (agent) {
    agent.name = discordAgentName;
  }

  if (!guildId) {
    return nextConfig;
  }

  const guildConfig = {
    requireMention,
  };
  if (allowedUserIds.length > 0) {
    guildConfig.users = allowedUserIds;
  }
  if (allowedChannelIds.length > 0) {
    guildConfig.channels = Object.fromEntries(
      allowedChannelIds.map((channelId) => [channelId, { allow: true, requireMention }]),
    );
  }

  nextConfig.bindings = ensureArray(nextConfig.bindings).filter(
    (binding) =>
      !(
        binding?.agentId === DEFAULT_DISCORD_AGENT_ID &&
        binding?.match?.channel === "discord" &&
        binding?.match?.guildId === guildId
      ),
  );
  nextConfig.bindings.push({
    agentId: DEFAULT_DISCORD_AGENT_ID,
    match: {
      channel: "discord",
      guildId,
    },
  });

  nextConfig.channels = ensureObject(nextConfig.channels);
  nextConfig.channels.discord = {
    enabled: true,
    dmPolicy: "pairing",
    groupPolicy: "allowlist",
    token: {
      source: "env",
      provider: "default",
      id: discordTokenEnv,
    },
    guilds: {
      [guildId]: guildConfig,
    },
  };

  if (automaticGroupReplies) {
    nextConfig.messages = ensureObject(nextConfig.messages);
    nextConfig.messages.groupChat = ensureObject(nextConfig.messages.groupChat);
    nextConfig.messages.groupChat.visibleReplies = "automatic";
  }

  return nextConfig;
}

export function resolveDiscordWorkspacePath(config, agentId = DEFAULT_DISCORD_AGENT_ID) {
  const agent = findAgent(config, agentId);
  return typeof agent?.workspace === "string" && agent.workspace.trim() ? agent.workspace : null;
}

export function seedRailwayBootstrapFiles(params = {}) {
  const env = params.env ?? process.env;
  const stateDir = env.OPENCLAW_STATE_DIR?.trim() || "/data/.openclaw";
  const configPath = env.OPENCLAW_CONFIG_PATH?.trim() || join(stateDir, "openclaw.json");
  const personaTemplateText =
    params.personaTemplateText ?? readFileSync(DEFAULT_PERSONA_TEMPLATE_PATH, "utf8");
  const nextConfig = buildRailwayBootstrapConfig({
    env,
    baseConfig: params.baseConfig,
  });

  let wroteConfig = false;
  if (!existsSync(configPath)) {
    writeJsonFile(configPath, nextConfig);
    wroteConfig = true;
  }

  const activeConfig = existsSync(configPath) ? readJsonFile(configPath) : nextConfig;
  const workspacePath = resolveDiscordWorkspacePath(activeConfig);
  let wrotePersona = false;
  if (workspacePath) {
    const agentsPath = join(workspacePath, "AGENTS.md");
    if (!existsSync(agentsPath)) {
      mkdirSync(workspacePath, { recursive: true });
      writeFileSync(agentsPath, personaTemplateText, "utf8");
      wrotePersona = true;
    }
  }

  return {
    configPath,
    workspacePath,
    wroteConfig,
    wrotePersona,
  };
}

function isDirectInvocation() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}

if (isDirectInvocation()) {
  const result = seedRailwayBootstrapFiles();
  if (result.wroteConfig) {
    console.log(`[railway-bootstrap] seeded config: ${result.configPath}`);
  }
  if (result.wrotePersona && result.workspacePath) {
    console.log(`[railway-bootstrap] seeded persona: ${join(result.workspacePath, "AGENTS.md")}`);
  }
}

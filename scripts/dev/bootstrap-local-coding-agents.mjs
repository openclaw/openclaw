#!/usr/bin/env node

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const homeDir = os.homedir();
const stateDir = resolveHomePath(process.env.OPENCLAW_STATE_DIR ?? path.join(homeDir, ".openclaw"));
const configPath = resolveHomePath(process.env.OPENCLAW_CONFIG_PATH ?? path.join(stateDir, "openclaw.json"));
const defaultModel = process.env.OPENCLAW_LOCAL_AGENT_MODEL ?? "openai-codex/gpt-5.3-codex-spark";
const agentIds = {
  builder: process.env.OPENCLAW_LOCAL_BUILDER_ID ?? "oc-builder",
  github: process.env.OPENCLAW_LOCAL_GITHUB_ID ?? "oc-github",
};

await ensureExists(path.dirname(configPath), "OpenClaw config directory");
const { config, rawConfig } = await readConfig();
const backupPath = await backupConfig(rawConfig);
mutateConfig(config);
await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");

console.log(
  JSON.stringify(
    {
      configPath,
      backupPath,
      repoRoot,
      agents: Object.values(agentIds),
      model: defaultModel,
    },
    null,
    2,
  ),
);

function resolveHomePath(value) {
  if (!value.startsWith("~")) {
    return path.resolve(value);
  }
  if (value === "~") {
    return homeDir;
  }
  return path.join(homeDir, value.slice(2));
}

async function ensureExists(targetPath, label) {
  try {
    await fs.access(targetPath);
  } catch {
    throw new Error(`${label} not found: ${targetPath}`);
  }
}

async function readConfig() {
  const rawConfig = await fs.readFile(configPath, "utf8");
  let config;
  try {
    config = JSON.parse(rawConfig);
  } catch (error) {
    throw new Error(`OpenClaw config must be valid JSON at ${configPath}: ${String(error)}`);
  }
  if (!config || typeof config !== "object") {
    throw new Error(`Invalid OpenClaw config object at ${configPath}`);
  }
  return { config, rawConfig };
}

async function backupConfig(rawConfig) {
  const backupPath = `${configPath}.bak.local-coding-agents-${Date.now()}`;
  await fs.writeFile(backupPath, rawConfig, "utf8");
  return backupPath;
}

function mutateConfig(config) {
  config.agents ??= {};
  config.agents.list = Array.isArray(config.agents.list) ? config.agents.list : [];
  config.tools ??= {};
  config.tools.agentToAgent ??= {};

  const desiredAgents = [
    {
      id: agentIds.builder,
      name: "OpenClaw Builder",
      workspace: repoRoot,
      model: defaultModel,
      skills: ["coding-agent", "github", "session-logs"],
      identity: {
        name: "OpenClaw Builder",
        theme: "Local code execution and patching",
        emoji: "🛠️",
      },
    },
    {
      id: agentIds.github,
      name: "OpenClaw GitHub",
      workspace: repoRoot,
      model: defaultModel,
      skills: ["github", "session-logs"],
      identity: {
        name: "OpenClaw GitHub",
        theme: "Repository and PR operations",
        emoji: "🐙",
      },
    },
  ];

  for (const agent of desiredAgents) {
    upsertAgent(config.agents.list, agent);
  }

  const allow = Array.isArray(config.tools.agentToAgent.allow) ? config.tools.agentToAgent.allow : [];
  config.tools.agentToAgent.allow = uniqueStrings([...allow, agentIds.builder, agentIds.github]);

  const mainAgent = config.agents.list.find((entry) => entry && entry.id === "main");
  if (mainAgent) {
    mainAgent.subagents ??= {};
    const allowAgents = Array.isArray(mainAgent.subagents.allowAgents) ? mainAgent.subagents.allowAgents : [];
    mainAgent.subagents.allowAgents = uniqueStrings([...allowAgents, agentIds.builder, agentIds.github]);
  }
}

function upsertAgent(list, nextAgent) {
  const index = list.findIndex((entry) => entry && entry.id === nextAgent.id);
  if (index === -1) {
    list.push(nextAgent);
    return;
  }
  list[index] = {
    ...list[index],
    ...nextAgent,
    identity: {
      ...(list[index].identity ?? {}),
      ...(nextAgent.identity ?? {}),
    },
  };
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === "string" && value.trim().length > 0))];
}

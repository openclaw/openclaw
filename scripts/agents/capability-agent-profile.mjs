#!/usr/bin/env node
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";

const require = createRequire(import.meta.url);
const {
  normalizeAgentOsCapabilityManifest,
  validateAgentOsCapabilityManifest,
} = require("../lib/agent-os-contracts.cjs");

export const CAPABILITY_AGENT_PROFILES = [
  {
    id: "research_agent",
    name: "Research Agent",
    description:
      "Owns research, retrieval, archive search, source comparison, and cited answer tickets.",
    contextInjection: "never",
    params: {
      capabilityAgent: true,
      capabilityFamily: "research",
      inspiredBy: ["Vane", "SearXNG", "Inbox Zero"],
      ticketTypes: [
        "research",
        "web_research",
        "private_search",
        "knowledge_search",
        "citation_answer",
      ],
    },
    skills: [
      "semantic-code-retrieval",
      "discrawl",
      "gitcrawl",
      "graincrawl",
      "notcrawl",
      "slacrawl",
      "swarm-memory",
      "openclaw-docs",
    ],
  },
  {
    id: "browser_ops_agent",
    name: "Browser Ops Agent",
    description:
      "Owns authorized browser automation, visual QA, session handoff, and web workflow tickets.",
    contextInjection: "never",
    params: {
      capabilityAgent: true,
      capabilityFamily: "browser-ops",
      inspiredBy: ["browser-act", "browser-use", "Camoufox"],
      ticketTypes: [
        "browser_ops",
        "browser_task",
        "web_automation",
        "web_qa",
        "browser_e2e",
        "ui_qa",
      ],
    },
    skills: [
      "visual-web-overlay",
      "openclaw-qa-testing",
      "openclaw-debugging",
      "telegram-crabbox-e2e-proof",
      "python-tools",
    ],
  },
  {
    id: "security_bouncer_agent",
    name: "Security Bouncer Agent",
    description:
      "Owns threat triage, dependency advisories, secret scanning, policy decisions, and repair tickets.",
    contextInjection: "never",
    params: {
      capabilityAgent: true,
      capabilityFamily: "security-bouncer",
      inspiredBy: ["CrowdSec", "Langfuse", "OpenTelemetry"],
      ticketTypes: [
        "security",
        "security_event",
        "security_incident",
        "threat_triage",
        "secret_scan",
        "dependency_advisory",
      ],
    },
    skills: [
      "security-triage",
      "openclaw-secret-scanning-maintainer",
      "openclaw-ghsa-maintainer",
      "openclaw-debugging",
      "openclaw-testing",
      "crabbox",
      "clawsweeper",
    ],
  },
];

export function capabilityManifestForProfile(profile) {
  return normalizeAgentOsCapabilityManifest({
    ...profile,
    artifacts: { kinds: ["proof-bundle", "json", "markdown"] },
    lifecycle: { heartbeatSeconds: 30, timeoutSeconds: 900 },
    proof: { commands: ["proof-events-bundle"], required: true },
    runtime: "native-openclaw",
    sandbox: {
      filesystem: "read",
      mode: "workspace-read",
      network: "allowlist",
      secrets: "named-refs-only",
    },
    tools: {
      allow: profile.skills,
      deny: [],
    },
  });
}

export const CAPABILITY_AGENT_MANIFESTS = CAPABILITY_AGENT_PROFILES.map(
  capabilityManifestForProfile,
);

function defaultConfigPath() {
  return path.join(os.homedir(), ".openclaw", "openclaw.json");
}

function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift() ?? "print";
  let configPath = defaultConfigPath();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--config") {
      const value = args[index + 1];
      if (!value) {
        throw new Error("--config requires a path");
      }
      configPath = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { command, configPath };
}

function readConfig(configPath) {
  if (!existsSync(configPath)) {
    throw new Error(`Config file does not exist: ${configPath}`);
  }
  return JSON5.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/u, ""));
}

export function mergeCapabilityAgents(config) {
  const next = {
    ...config,
    agents: {
      ...(config.agents && typeof config.agents === "object" ? config.agents : {}),
    },
  };
  const list = Array.isArray(next.agents.list) ? [...next.agents.list] : [];
  const byId = new Map(
    list
      .map((entry, index) =>
        entry && typeof entry === "object" && typeof entry.id === "string"
          ? [entry.id, { entry, index }]
          : null,
      )
      .filter(Boolean),
  );

  const changed = [];
  for (const profile of CAPABILITY_AGENT_PROFILES) {
    const existing = byId.get(profile.id);
    const previous = existing?.entry && typeof existing.entry === "object" ? existing.entry : {};
    const merged = {
      ...previous,
      id: profile.id,
      name: profile.name,
      description: profile.description,
      params: {
        ...(previous.params && typeof previous.params === "object" ? previous.params : {}),
        ...profile.params,
        agentOsCapability: capabilityManifestForProfile(profile),
      },
      skills: profile.skills,
      contextInjection: profile.contextInjection,
    };
    delete merged.systemPromptOverride;
    if (existing) {
      list[existing.index] = merged;
      changed.push({ action: "updated", id: profile.id });
    } else {
      list.push(merged);
      changed.push({ action: "added", id: profile.id });
    }
  }
  next.agents.list = list;
  return { changed, config: next };
}

function checkCapabilityAgents(config) {
  const list = Array.isArray(config.agents?.list) ? config.agents.list : [];
  const byId = new Map(
    list
      .filter((entry) => entry && typeof entry === "object" && typeof entry.id === "string")
      .map((entry) => [entry.id, entry]),
  );
  return CAPABILITY_AGENT_PROFILES.map((profile) => {
    const installed = byId.get(profile.id);
    const installedManifest = installed?.params?.agentOsCapability;
    const manifest = capabilityManifestForProfile(profile);
    const validation = validateAgentOsCapabilityManifest(manifest);
    const installedManifestValidation = installedManifest
      ? validateAgentOsCapabilityManifest(installedManifest)
      : { ok: false };
    return {
      id: profile.id,
      installed: Boolean(installed),
      installedManifestValid: installedManifestValidation.ok,
      manifestValid: validation.ok,
      ticketTypes: profile.params.ticketTypes,
    };
  });
}

function printProfiles() {
  process.stdout.write(
    `${JSON.stringify(
      {
        agents: {
          list: CAPABILITY_AGENT_PROFILES,
        },
        capabilityManifests: CAPABILITY_AGENT_MANIFESTS,
      },
      null,
      2,
    )}\n`,
  );
}

function writeConfig(configPath, config) {
  const backupPath = `${configPath}.capability-agents.bak`;
  if (existsSync(configPath)) {
    copyFileSync(configPath, backupPath);
  }
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function runCapabilityAgentProfileCli(argv = process.argv.slice(2)) {
  const { command, configPath } = parseArgs(argv);
  if (command === "print") {
    printProfiles();
    return 0;
  }
  if (command === "check") {
    const config = readConfig(configPath);
    process.stdout.write(
      `${JSON.stringify({ configPath, profiles: checkCapabilityAgents(config) }, null, 2)}\n`,
    );
    return 0;
  }
  if (command === "apply") {
    const config = readConfig(configPath);
    const result = mergeCapabilityAgents(config);
    writeConfig(configPath, result.config);
    process.stdout.write(
      `${JSON.stringify({ configPath, changed: result.changed, profiles: checkCapabilityAgents(result.config) }, null, 2)}\n`,
    );
    return 0;
  }
  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    process.exit(runCapabilityAgentProfileCli());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

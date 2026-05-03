#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    policy: path.join(homedir(), ".openclaw", "channels", "access-policy.json"),
    init: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    } else if (arg === "--policy") {
      args.policy = argv[++i] ?? args.policy;
    } else if (arg === "--init") {
      args.init = true;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/channels-access-policy-check.mjs [options]

Validate chat-channel remote-control policy before exposing an agent to Telegram, Discord, or iMessage.

Options:
  --policy <path>   Policy JSON (default: ~/.openclaw/channels/access-policy.json)
  --init            Create a locked-down template if missing
  --json            Print JSON
`);
}

function template() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    defaultDeny: true,
    channels: [
      {
        name: "telegram",
        enabled: false,
        allowedUserIds: [],
        allowedUsernames: [],
        allowedChats: [],
      },
    ],
    loops: {
      enabled: false,
      minIntervalMinutes: 60,
      maxRuntimeMinutes: 15,
      requireStopCommand: true,
    },
    permissions: {
      allowFileEdits: true,
      allowShell: false,
      allowNetwork: false,
      allowPublicPosting: false,
      allowMergeOrDeploy: false,
      allowCredentialChanges: false,
    },
    checkpoints: {
      requireHumanForExternalState: true,
      requireHumanForSecrets: true,
      requireHumanForCronEnable: true,
      requireReviewFolder: true,
    },
  };
}

function readPolicy(file, init) {
  if (!existsSync(file)) {
    if (!init) {
      throw new Error(`Policy missing: ${file}. Run with --init to create a locked-down template.`);
    }
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(template(), null, 2)}\n`, { mode: 0o600 });
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

function includesWildcard(values) {
  return (values ?? []).some((value) => value === "*" || value === "all" || value === "public");
}

function validate(policy, file) {
  const findings = [];
  if (policy.defaultDeny !== true) {
    findings.push("defaultDeny must be true.");
  }
  for (const channel of policy.channels ?? []) {
    if (channel.enabled && includesWildcard(channel.allowedUserIds)) {
      findings.push(`${channel.name}: wildcard allowedUserIds is not allowed.`);
    }
    if (channel.enabled && includesWildcard(channel.allowedUsernames)) {
      findings.push(`${channel.name}: wildcard allowedUsernames is not allowed.`);
    }
    if (channel.enabled && includesWildcard(channel.allowedChats)) {
      findings.push(`${channel.name}: wildcard allowedChats is not allowed.`);
    }
    const userCount = [
      ...(channel.allowedUserIds ?? []),
      ...(channel.allowedUsernames ?? []),
      ...(channel.allowedChats ?? []),
    ].length;
    if (channel.enabled && userCount === 0) {
      findings.push(`${channel.name}: enabled channel has no explicit allowlist.`);
    }
  }
  if (policy.loops?.enabled && (policy.loops?.minIntervalMinutes ?? 0) < 30) {
    findings.push("loop minIntervalMinutes must be at least 30.");
  }
  if (policy.loops?.enabled && (policy.loops?.maxRuntimeMinutes ?? 999) > 30) {
    findings.push("loop maxRuntimeMinutes must be 30 or less.");
  }
  if (policy.loops?.enabled && policy.loops?.requireStopCommand !== true) {
    findings.push("loop jobs must require an explicit stop command.");
  }
  for (const [key, value] of Object.entries(policy.permissions ?? {})) {
    if (/PublicPosting|MergeOrDeploy|CredentialChanges/i.test(key) && value === true) {
      findings.push(`${key} must stay false for chat-channel control.`);
    }
  }
  for (const [key, value] of Object.entries(policy.checkpoints ?? {})) {
    if (value !== true) {
      findings.push(`${key} checkpoint must be true.`);
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    file,
    ok: findings.length === 0,
    enabledChannels: (policy.channels ?? [])
      .filter((channel) => channel.enabled)
      .map((channel) => channel.name),
    loopsEnabled: policy.loops?.enabled === true,
    findings,
  };
}

function renderMarkdown(result) {
  return `# Channels Access Policy Check

Generated: ${result.generatedAt}
Policy: \`${result.file}\`
Status: ${result.ok ? "pass" : "review"}

## Enabled Channels

${result.enabledChannels.length ? result.enabledChannels.map((name) => `- ${name}`).join("\n") : "- None"}

## Loop Jobs

- Enabled: ${result.loopsEnabled ? "yes" : "no"}

## Findings

${result.findings.length ? result.findings.map((finding) => `- ${finding}`).join("\n") : "- None"}
`;
}

const args = parseArgs(process.argv.slice(2));
const file = path.resolve(args.policy);
const policy = readPolicy(file, args.init);
const result = validate(policy, file);
process.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : renderMarkdown(result));
if (!result.ok) {
  process.exitCode = 1;
}

#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    policy: path.join(process.cwd(), "automation", "tunnels", "zrok-policy.json"),
    target: null,
    mode: "private",
    ttlMinutes: 60,
    backendMode: "proxy",
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    } else if (arg === "--policy") {
      args.policy = argv[++i] ?? args.policy;
    } else if (arg === "--target") {
      args.target = argv[++i] ?? args.target;
    } else if (arg === "--mode") {
      args.mode = argv[++i] ?? args.mode;
    } else if (arg === "--ttl-minutes") {
      args.ttlMinutes = Number(argv[++i] ?? args.ttlMinutes);
    } else if (arg === "--backend-mode") {
      args.backendMode = argv[++i] ?? args.backendMode;
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
  console.log(`Usage: node scripts/tunnel-policy-check.mjs [options]

Validate a zrok/ngrok-style tunnel request before exposing localhost or files.

Options:
  --target <host:port|path>      Target to share
  --mode <private|public>        Share mode (default: private)
  --ttl-minutes <minutes>        Intended lifetime (default: 60)
  --backend-mode <proxy|drive>   Backend mode (default: proxy)
  --json                         Print JSON
`);
}

function readPolicy(file) {
  if (!existsSync(file)) {
    throw new Error(`Policy not found: ${file}`);
  }
  return JSON.parse(readFileSync(file, "utf8"));
}

function normalizeTarget(target) {
  return String(target ?? "")
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
}

function validate(args, policy) {
  const findings = [];
  const target = normalizeTarget(args.target);
  if (!target) {
    findings.push("target is required.");
  }
  if (args.mode === "public" && policy.allowPublic !== true) {
    findings.push("public tunnel mode is disabled by policy.");
  }
  if (args.mode === "public" && policy.requireHumanForPublic !== true) {
    findings.push("public tunnel requests must require human approval.");
  }
  if ((policy.blockedTargets ?? []).includes(target)) {
    findings.push(`target ${target} is blocked by policy.`);
  }
  if ((args.ttlMinutes ?? 0) > policy.maxTtlMinutes) {
    findings.push(`ttl ${args.ttlMinutes} exceeds max ${policy.maxTtlMinutes} minutes.`);
  }
  if (args.backendMode === "drive" && policy.requireHumanForDriveShare !== true) {
    findings.push("drive sharing must require human approval.");
  }
  if (args.backendMode === "drive" && args.mode !== "private") {
    findings.push("drive sharing must use private mode.");
  }
  return {
    generatedAt: new Date().toISOString(),
    ok: findings.length === 0,
    request: {
      target,
      mode: args.mode,
      ttlMinutes: args.ttlMinutes,
      backendMode: args.backendMode,
    },
    command:
      args.backendMode === "drive"
        ? `zrok share ${args.mode} --backend-mode drive ${target}`
        : `zrok share ${args.mode} ${target}`,
    findings,
    reviewPath: policy.logReviewPath,
  };
}

function renderMarkdown(result) {
  return `# Tunnel Policy Check

Generated: ${result.generatedAt}
Status: ${result.ok ? "pass" : "review"}

## Request

- Target: \`${result.request.target}\`
- Mode: ${result.request.mode}
- TTL: ${result.request.ttlMinutes} minutes
- Backend mode: ${result.request.backendMode}
- Proposed command: \`${result.command}\`

## Findings

${result.findings.length ? result.findings.map((finding) => `- ${finding}`).join("\n") : "- None"}

Review path: \`${result.reviewPath}\`
`;
}

const args = parseArgs(process.argv.slice(2));
const result = validate(args, readPolicy(path.resolve(args.policy)));
const output = args.json ? `${JSON.stringify(result, null, 2)}\n` : renderMarkdown(result);
const reviewPath = result.reviewPath?.replace(/^~(?=\/)/, process.env.HOME ?? "~");
if (reviewPath) {
  mkdirSync(reviewPath, { recursive: true });
  writeFileSync(path.join(reviewPath, "latest-tunnel-check.md"), renderMarkdown(result), {
    mode: 0o600,
  });
}
process.stdout.write(output);
if (!result.ok) {
  process.exitCode = 1;
}

#!/usr/bin/env node
import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 24_000;

function parseArgs(argv) {
  const opts = {
    json: false,
    output: null,
    repo: process.cwd(),
    openclawBin: process.env.OPENCLAW_BIN ?? "openclaw",
    timeoutMs: DEFAULT_TIMEOUT_MS,
    skipDeep: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--skip-deep") {
      opts.skipDeep = true;
    } else if (arg === "--output") {
      opts.output = argv[++i];
    } else if (arg === "--repo") {
      opts.repo = argv[++i];
    } else if (arg === "--openclaw-bin") {
      opts.openclawBin = argv[++i];
    } else if (arg === "--timeout-ms") {
      opts.timeoutMs = Number(argv[++i]);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number");
  }

  return opts;
}

function printHelp() {
  console.log(`Usage: node scripts/openclaw-install-maintenance.mjs [options]

Read-only maintenance report for an OpenClaw host install.

Options:
  --json                    Print machine-readable JSON
  --output <path>           Write report to a file instead of stdout
  --repo <path>             Repo path for git status checks (default: cwd)
  --openclaw-bin <path>     OpenClaw binary to run (default: openclaw)
  --timeout-ms <ms>         Per-command timeout (default: ${DEFAULT_TIMEOUT_MS})
  --skip-deep               Use non-deep security audit
`);
}

function redact(value) {
  return String(value)
    .replace(
      /^([^\n]*(?:TOKEN|PASSWORD|API[_-]?KEY|SECRET|TAVILY_API_KEY)[^\n]*=>)\s*.*$/gim,
      "$1 [REDACTED]",
    )
    .replace(
      /^([^\n]*(?:TOKEN|PASSWORD|API[_-]?KEY|SECRET|TAVILY_API_KEY)[^\n]*=)\s*.*$/gim,
      "$1[REDACTED]",
    )
    .replace(/(authorization:\s*bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/(x-openclaw-token:\s*)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/(token|password|api[_-]?key|secret)(["'\s:=]+)([^"'\s,}]+)/gi, "$1$2[REDACTED]")
    .replace(
      /\b(ocw|sk|ghp|github_pat|xox[baprs]|slack|tvly-dev)-[A-Za-z0-9._-]{12,}\b/g,
      "[REDACTED]",
    )
    .slice(0, MAX_OUTPUT_CHARS);
}

async function runCheck(id, command, args, opts = {}) {
  const startedAt = new Date().toISOString();
  try {
    const result = await execFileAsync(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, NO_COLOR: "1", OPENCLAW_NO_COLOR: "1" },
      timeout: opts.timeoutMs,
      maxBuffer: 1024 * 1024 * 8,
    });
    return {
      id,
      command: [command, ...args],
      ok: true,
      exitCode: 0,
      startedAt,
      stdout: redact(result.stdout),
      stderr: redact(result.stderr),
    };
  } catch (err) {
    return {
      id,
      command: [command, ...args],
      ok: false,
      exitCode: typeof err.code === "number" ? err.code : null,
      signal: err.signal ?? null,
      startedAt,
      stdout: redact(err.stdout ?? ""),
      stderr: redact(err.stderr ?? err.message ?? ""),
    };
  }
}

function inspectLocalFiles() {
  const root = path.join(homedir(), ".openclaw");
  const launchAgents = path.join(homedir(), "Library", "LaunchAgents");
  const backupCount = existsSync(root)
    ? readdirSync(root).filter((name) => name.startsWith("openclaw.json.bak")).length
    : 0;

  const plistNames = ["ai.openclaw.gateway.plist", "ai.openclaw.mac.plist"];
  const launchdPlists = plistNames.map((name) => {
    const file = path.join(launchAgents, name);
    if (!existsSync(file)) {
      return { name, exists: false };
    }
    const stats = statSync(file);
    return { name, exists: true, modifiedAt: stats.mtime.toISOString(), bytes: stats.size };
  });

  return {
    openclawRootExists: existsSync(root),
    configExists: existsSync(path.join(root, "openclaw.json")),
    backupCount,
    launchdPlists,
  };
}

function buildFindings(checks, files) {
  const findings = [];
  const failed = checks.filter((check) => !check.ok);
  for (const check of failed) {
    findings.push({
      severity: check.id.includes("security") || check.id.includes("doctor") ? "warn" : "info",
      id: `${check.id}.failed`,
      message: `${check.id} failed or timed out; inspect the redacted output.`,
    });
  }

  if (!files.configExists) {
    findings.push({
      severity: "warn",
      id: "config.missing",
      message: "~/.openclaw/openclaw.json was not found.",
    });
  }

  if (files.backupCount > 10) {
    findings.push({
      severity: "info",
      id: "config.backups.many",
      message: `${files.backupCount} OpenClaw config backups exist; consider pruning old known-good backups after confirming current config is stable.`,
    });
  }

  const gatewayPlist = files.launchdPlists.find(
    (entry) => entry.name === "ai.openclaw.gateway.plist",
  );
  if (process.platform === "darwin" && gatewayPlist && !gatewayPlist.exists) {
    findings.push({
      severity: "info",
      id: "launchd.gateway.plist_missing",
      message:
        "Gateway LaunchAgent plist was not found; this is expected only when the gateway is not installed as a daemon.",
    });
  }

  return findings;
}

function renderMarkdown(report) {
  const lines = [
    "# OpenClaw Install Maintenance Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Platform: ${report.platform}`,
    `Repo: ${report.repo}`,
    "",
    "## Findings",
    "",
  ];

  if (report.findings.length === 0) {
    lines.push(
      "- No findings from the maintenance wrapper. Review doctor/security output for detailed warnings.",
    );
  } else {
    for (const finding of report.findings) {
      lines.push(`- ${finding.severity.toUpperCase()}: ${finding.id} - ${finding.message}`);
    }
  }

  lines.push("", "## Checks", "");
  for (const check of report.checks) {
    lines.push(`### ${check.id}`);
    lines.push("");
    lines.push(`Command: \`${check.command.join(" ")}\``);
    lines.push(`Status: ${check.ok ? "ok" : "failed"}`);
    if (check.stdout.trim()) {
      lines.push("", "stdout:", "```text", check.stdout.trim(), "```");
    }
    if (check.stderr.trim()) {
      lines.push("", "stderr:", "```text", check.stderr.trim(), "```");
    }
    lines.push("");
  }

  lines.push("## Local Metadata", "", "```json", JSON.stringify(report.files, null, 2), "```");
  return lines.join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const repo = path.resolve(opts.repo);
  const timeoutMs = opts.timeoutMs;
  const launchdDomain = typeof process.getuid === "function" ? `gui/${process.getuid()}` : null;

  const checks = [];
  checks.push(await runCheck("node.version", "node", ["--version"], { timeoutMs }));
  checks.push(await runCheck("openclaw.version", opts.openclawBin, ["--version"], { timeoutMs }));
  checks.push(
    await runCheck("openclaw.status.deep", opts.openclawBin, ["status", "--deep"], { timeoutMs }),
  );
  checks.push(await runCheck("openclaw.doctor", opts.openclawBin, ["doctor"], { timeoutMs }));
  checks.push(
    await runCheck(
      opts.skipDeep ? "openclaw.security.audit" : "openclaw.security.audit.deep",
      opts.openclawBin,
      opts.skipDeep ? ["security", "audit"] : ["security", "audit", "--deep"],
      { timeoutMs },
    ),
  );
  checks.push(
    await runCheck("openclaw.update.status", opts.openclawBin, ["update", "status"], { timeoutMs }),
  );
  checks.push(await runCheck("git.status", "git", ["status", "--short"], { cwd: repo, timeoutMs }));

  if (process.platform === "darwin" && launchdDomain) {
    checks.push(
      await runCheck(
        "launchd.gateway",
        "launchctl",
        ["print", `${launchdDomain}/ai.openclaw.gateway`],
        { timeoutMs },
      ),
    );
    checks.push(
      await runCheck("launchd.mac", "launchctl", ["print", `${launchdDomain}/ai.openclaw.mac`], {
        timeoutMs,
      }),
    );
    checks.push(
      await runCheck("port.18789", "lsof", ["-nP", "-iTCP:18789", "-sTCP:LISTEN"], { timeoutMs }),
    );
  }

  const files = inspectLocalFiles();
  const report = {
    generatedAt: new Date().toISOString(),
    platform: `${process.platform} ${process.arch}`,
    repo,
    files,
    findings: buildFindings(checks, files),
    checks,
  };

  const output = opts.json ? JSON.stringify(report, null, 2) : renderMarkdown(report);
  if (opts.output) {
    writeFileSync(path.resolve(opts.output), `${output}\n`, { mode: 0o600 });
  } else {
    console.log(output);
  }
}

main().catch((err) => {
  console.error(`openclaw-install-maintenance failed: ${err.message}`);
  process.exit(1);
});

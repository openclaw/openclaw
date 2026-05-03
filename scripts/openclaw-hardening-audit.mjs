#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

function parseArgs(argv) {
  const args = {
    config: path.join(homedir(), ".openclaw", "openclaw.json"),
    cron: path.join(homedir(), ".openclaw", "cron", "jobs.json"),
    plist: path.join(homedir(), "Library", "LaunchAgents", "ai.openclaw.gateway.plist"),
    json: false,
    output: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      continue;
    } else if (arg === "--json") {
      args.json = true;
    } else if (arg === "--config") {
      args.config = argv[++i] ?? args.config;
    } else if (arg === "--cron") {
      args.cron = argv[++i] ?? args.cron;
    } else if (arg === "--plist") {
      args.plist = argv[++i] ?? args.plist;
    } else if (arg === "--output") {
      args.output = argv[++i] ?? args.output;
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
  console.log(`Usage: node scripts/openclaw-hardening-audit.mjs [options]

Read-only audit for always-on OpenClaw hardening controls.

Options:
  --json              Print JSON instead of Markdown
  --config <path>     OpenClaw config path
  --cron <path>       OpenClaw cron jobs path
  --plist <path>      Gateway LaunchAgent plist path
  --output <path>     Write report to file
`);
}

function readJsonIfExists(file) {
  if (!existsSync(file)) {
    return { exists: false, value: null };
  }
  return { exists: true, value: JSON.parse(readFileSync(file, "utf8")) };
}

function listPlistEnvKeys(file) {
  if (!existsSync(file)) {
    return [];
  }
  const xml = readFileSync(file, "utf8");
  const envStart = xml.indexOf("<key>EnvironmentVariables</key>");
  if (envStart < 0) {
    return [];
  }
  const envBody = xml.slice(envStart, xml.indexOf("</dict>", envStart + 1));
  return [...envBody.matchAll(/<key>([^<]+)<\/key>/g)]
    .map((match) => match[1])
    .filter((key) => key !== "EnvironmentVariables");
}

function hasWildcard(value) {
  if (Array.isArray(value)) {
    return value.includes("*");
  }
  if (value && typeof value === "object") {
    return Object.values(value).some(hasWildcard);
  }
  return value === "*";
}

function summarizeJobs(cronValue) {
  const jobs = Array.isArray(cronValue?.jobs) ? cronValue.jobs : [];
  const enabled = jobs.filter((job) => job?.enabled !== false);
  const agentTurns = jobs.filter((job) => job?.payload?.kind === "agentTurn");
  const riskyModels = jobs.filter(
    (job) => typeof job?.payload?.model === "string" && /gpt-5\.5|^gpt$/.test(job.payload.model),
  );
  const riskyDeliveries = jobs.filter((job) => job?.delivery?.mode && job.delivery.mode !== "none");
  return {
    total: jobs.length,
    enabled: enabled.length,
    agentTurns: agentTurns.length,
    riskyModelJobs: riskyModels.map((job) => job.name ?? job.id).filter(Boolean),
    deliveryJobs: riskyDeliveries.map((job) => job.name ?? job.id).filter(Boolean),
  };
}

function addFinding(findings, severity, id, message, remediation) {
  findings.push({ severity, id, message, remediation });
}

function audit({ config, cron, plist }) {
  const findings = [];
  const configRead = readJsonIfExists(config);
  const cronRead = readJsonIfExists(cron);
  const cfg = configRead.value ?? {};
  const cronValue = cronRead.value ?? {};
  const plistEnvKeys = listPlistEnvKeys(plist);
  const cronSummary = summarizeJobs(cronValue);

  if (!configRead.exists) {
    addFinding(
      findings,
      "critical",
      "config.missing",
      "OpenClaw config file is missing.",
      "Run openclaw setup or restore a known-good backup.",
    );
  }

  if (cfg.gateway?.bind !== "loopback") {
    addFinding(
      findings,
      "critical",
      "gateway.bind.not_loopback",
      `Gateway bind is ${JSON.stringify(cfg.gateway?.bind)}.`,
      "Set gateway.bind to loopback and use Tailscale/SSH tunnels for remote access.",
    );
  }

  if (cfg.gateway?.auth?.mode !== "token") {
    addFinding(
      findings,
      "critical",
      "gateway.auth.not_token",
      "Gateway auth is not token mode.",
      "Use token auth for local and tunneled dashboard access.",
    );
  }

  if (hasWildcard(cfg.tools?.elevated?.allowFrom)) {
    addFinding(
      findings,
      "critical",
      "tools.elevated.wildcard",
      "Elevated tool allowlist contains a wildcard.",
      "Remove '*' and name only trusted local users/sessions.",
    );
  }

  if (cfg.tools?.exec?.security === "full") {
    addFinding(
      findings,
      "warn",
      "tools.exec.full",
      "Exec security is full trust.",
      "Use allowlist mode and require approval for new elevated commands.",
    );
  }

  if (cfg.cron?.enabled !== false) {
    addFinding(
      findings,
      "warn",
      "cron.enabled",
      "Cron is enabled.",
      "Keep cron disabled until autonomous jobs are pruned, bounded, and reviewed.",
    );
  }

  if (cronSummary.enabled > 0) {
    addFinding(
      findings,
      "warn",
      "cron.jobs.enabled",
      `${cronSummary.enabled} cron jobs are enabled.`,
      "Enable only reviewed jobs with bounded timeouts and no public side effects.",
    );
  }

  if (cronSummary.riskyModelJobs.length > 0) {
    addFinding(
      findings,
      "warn",
      "cron.jobs.risky_models",
      `${cronSummary.riskyModelJobs.length} jobs reference unstable shorthand or gpt-5.5 models.`,
      "Pin scheduled jobs to known-good models such as openai-codex/gpt-5.4.",
    );
  }

  if (cronSummary.deliveryJobs.length > 0) {
    addFinding(
      findings,
      "info",
      "cron.jobs.delivery",
      `${cronSummary.deliveryJobs.length} jobs request delivery.`,
      "Prefer delivery.mode=none and a human checkpoint inbox for scheduled work.",
    );
  }

  const secretEnvKeys = plistEnvKeys.filter((key) =>
    /TOKEN|PASSWORD|SECRET|API[_-]?KEY/i.test(key),
  );
  if (secretEnvKeys.length > 0) {
    addFinding(
      findings,
      "warn",
      "launchd.secret_env",
      `LaunchAgent contains secret-like environment keys: ${secretEnvKeys.join(", ")}.`,
      "Move secrets to a dedicated secret provider or a tightly scoped runtime env outside agent-readable files.",
    );
  }

  return {
    generatedAt: new Date().toISOString(),
    inputs: { config, cron, plist },
    summary: {
      configExists: configRead.exists,
      cronExists: cronRead.exists,
      plistExists: existsSync(plist),
      gatewayBind: cfg.gateway?.bind ?? null,
      gatewayAuthMode: cfg.gateway?.auth?.mode ?? null,
      execSecurity: cfg.tools?.exec?.security ?? null,
      cronEnabled: cfg.cron?.enabled ?? null,
      cron: cronSummary,
      plistEnvKeys,
    },
    findings,
  };
}

function renderMarkdown(report) {
  const lines = [
    "# OpenClaw Hardening Audit",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    "## Summary",
    "",
    `- Gateway: bind=${report.summary.gatewayBind ?? "unknown"}, auth=${report.summary.gatewayAuthMode ?? "unknown"}`,
    `- Exec security: ${report.summary.execSecurity ?? "unknown"}`,
    `- Cron: enabled=${String(report.summary.cronEnabled)}, jobs=${report.summary.cron.total}, enabledJobs=${report.summary.cron.enabled}`,
    `- LaunchAgent env keys: ${report.summary.plistEnvKeys.length > 0 ? report.summary.plistEnvKeys.join(", ") : "none"}`,
    "",
    "## Findings",
    "",
  ];
  if (report.findings.length === 0) {
    lines.push("- OK: no high-ROI hardening gaps detected by this audit.");
  } else {
    for (const finding of report.findings) {
      lines.push(`- ${finding.severity.toUpperCase()}: ${finding.id} - ${finding.message}`);
      lines.push(`  Remediation: ${finding.remediation}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

const args = parseArgs(process.argv.slice(2));
const report = audit(args);
const output = args.json ? `${JSON.stringify(report, null, 2)}\n` : renderMarkdown(report);
if (args.output) {
  writeFileSync(path.resolve(args.output), output, { mode: 0o600 });
} else {
  process.stdout.write(output);
}

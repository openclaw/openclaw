import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const currentFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(currentFile), "..");
const DEFAULT_REPORT_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-capital-hft-compatibility-latest.json",
);
const DEFAULT_MD_PATH = path.join(
  repoRoot,
  "reports",
  "hermes-agent",
  "state",
  "openclaw-capital-capital-hft-compatibility-latest.md",
);

const REQUIRED_ALIAS_PAIRS = [
  ["capital:quote:reportable", "capital-hft:quote:reportable"],
  ["capital:quote:reportable:check", "capital-hft:quote:reportable:check"],
  ["capital:master-flow-checklist", "capital-hft:capital:master-flow-checklist"],
  ["capital:master-flow-checklist:check", "capital-hft:capital:master-flow-checklist:check"],
  ["capital:completeness-report", "capital-hft:capital:completeness-report"],
  ["capital:completeness-report:check", "capital-hft:capital:completeness-report:check"],
  ["capital:contract-month-router", "capital-hft:capital:contract-month-router"],
  ["capital:contract-month-router:check", "capital-hft:capital:contract-month-router:check"],
  ["capital:full-chain", "capital-hft:capital:full-chain"],
  ["capital:full-chain:check", "capital-hft:capital:full-chain:check"],
  ["capital:latency-gap", "capital-hft:capital:latency-gap"],
  ["capital:latency-gap:check", "capital-hft:capital:latency-gap:check"],
  ["capital:simulated-live", "capital-hft:capital:simulated-live"],
  ["capital:simulated-live:check", "capital-hft:capital:simulated-live:check"],
  ["capital:simulation-diagnostics", "capital-hft:capital:simulation-diagnostics"],
  ["capital:simulation-diagnostics:check", "capital-hft:capital:simulation-diagnostics:check"],
  ["capital:simulation:1000", "capital-hft:capital:simulation:1000"],
  ["capital:simulation:1000:check", "capital-hft:capital:simulation:1000:check"],
  ["capital:live-order-dry-run", "capital-hft:capital:live-order-dry-run"],
  ["capital:live-order-dry-run:check", "capital-hft:capital:live-order-dry-run:check"],
  ["capital:live-strategy:readiness", "capital-hft:live-strategy:readiness"],
  ["capital:live-strategy:readiness:check", "capital-hft:live-strategy:readiness:check"],
  ["capital:live-trading:approval:summary", "capital-hft:live-trading:approval:summary"],
  [
    "capital:live-trading:approval:summary:check",
    "capital-hft:live-trading:approval:summary:check",
  ],
  ["capital:live-trading:approval:sync", "capital-hft:live-trading:approval:sync"],
  ["capital:live-trading:approval:sync:check", "capital-hft:live-trading:approval:sync:check"],
  ["capital:live-trading:approval:check", "capital-hft:live-trading:approval:check"],
  ["capital:live-trading:human-approval", "capital-hft:live-trading:human-approval"],
  ["capital:live-trading:human-approval:check", "capital-hft:live-trading:human-approval:check"],
  ["capital:live-trading:promotion", "capital-hft:live-trading:promotion"],
  ["capital:live-trading:promotion:check", "capital-hft:live-trading:promotion:check"],
  ["capital:overseas-rotation", "capital-hft:capital:overseas-rotation"],
  ["capital:overseas-rotation:check", "capital-hft:capital:overseas-rotation:check"],
  ["capital:paper-loop", "capital-hft:paper-loop"],
  ["capital:paper-loop:check", "capital-hft:paper-loop:check"],
  ["capital:strategy:bar-accumulator", "capital-hft:strategy:bar-accumulator"],
  ["capital:strategy:bar-accumulator:json", "capital-hft:strategy:bar-accumulator:json"],
  ["capital:strategy:engine", "capital-hft:strategy:engine"],
  ["capital:strategy:engine:check", "capital-hft:strategy:engine:check"],
  ["capital:strategy:engine:json", "capital-hft:strategy:engine:json"],
  ["capital:strategy:fill-simulation", "capital-hft:strategy:fill-simulation"],
  ["capital:strategy:fill-simulation:json", "capital-hft:strategy:fill-simulation:json"],
  ["capital:walk-forward:qmd", "capital-hft:capital:walk-forward:qmd"],
  ["capital:walk-forward:qmd:check", "capital-hft:capital:walk-forward:qmd:check"],
];

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function readJson(filePath) {
  return JSON.parse((await fs.readFile(filePath, "utf8")).replace(/^\uFEFF/u, ""));
}

async function writeTextWithSha(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function writeJsonWithSha(filePath, value) {
  await writeTextWithSha(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function renderMarkdown(report) {
  return [
    "# Capital CapitalHftService Compatibility",
    "",
    `- status: ${report.status}`,
    `- preferredPrefix: ${report.policy.preferredPrefix}`,
    `- legacyPrefix: ${report.policy.legacyPrefix}`,
    `- capitalHftScriptCount: ${report.summary.capitalHftScriptCount}`,
    `- requiredAliasCount: ${report.summary.requiredAliasCount}`,
    `- mismatchCount: ${report.summary.mismatchCount}`,
    `- nextSafeTask: ${report.nextSafeTask}`,
    "",
    "## Required Aliases",
    ...report.aliases.map(
      (item) => `- ${item.status}: \`${item.preferred}\` == \`${item.legacy}\``,
    ),
    "",
  ].join("\n");
}

export async function buildCapitalHftCompatibility(options = {}) {
  const packagePath = path.resolve(options.packagePath || path.join(repoRoot, "package.json"));
  const pkg = await readJson(packagePath);
  const scripts = pkg.scripts || {};
  const capitalHftScriptNames = Object.keys(scripts).filter((name) =>
    name.startsWith("capital-hft:"),
  );
  const aliases = REQUIRED_ALIAS_PAIRS.map(([preferred, legacy]) => {
    const preferredCommand = scripts[preferred] || "";
    const legacyCommand = scripts[legacy] || "";
    const missing = [];
    if (!preferredCommand) {
      missing.push("preferred");
    }
    if (!legacyCommand) {
      missing.push("legacy");
    }
    const commandsMatch = Boolean(preferredCommand) && preferredCommand === legacyCommand;
    return {
      preferred,
      legacy,
      status: missing.length === 0 && commandsMatch ? "pass" : "fail",
      missing,
      commandsMatch,
      command: preferredCommand || legacyCommand,
    };
  });
  const failures = aliases.filter((item) => item.status !== "pass");
  return {
    schema: "openclaw.capital.capital-hft-compatibility.v1",
    generatedAt: (options.now instanceof Date ? options.now : new Date()).toISOString(),
    status: failures.length === 0 ? "passed" : "failed",
    policy: {
      preferredPrefix: "capital:*",
      legacyPrefix: "capital-hft:*",
      capitalHftPolicy: "compatibility_alias_only",
      doNotUseAsArchitectureName: true,
      keepLegacyAliases: true,
      removeLegacyAliases: false,
    },
    summary: {
      capitalHftScriptCount: capitalHftScriptNames.length,
      requiredAliasCount: REQUIRED_ALIAS_PAIRS.length,
      passedAliasCount: aliases.length - failures.length,
      mismatchCount: failures.length,
    },
    aliases,
    failures,
    safety: {
      liveTradingEnabled: false,
      writeBrokerOrders: false,
      sentOrder: false,
      noBrokerWrite: true,
    },
    nextSafeTask:
      failures.length === 0
        ? "後續報告與自動化優先顯示 capital:*；capital-hft:* 僅保留相容，不再作為架構名稱。"
        : "修正失配的 capital/capital-hft script alias，避免舊入口與新入口行為分歧。",
  };
}

async function main() {
  const reportPath = path.resolve(argValue("--output", DEFAULT_REPORT_PATH));
  const markdownPath = path.resolve(argValue("--markdown", DEFAULT_MD_PATH));
  const report = await buildCapitalHftCompatibility();

  if (hasFlag("--write-state")) {
    await writeJsonWithSha(reportPath, report);
    await writeTextWithSha(markdownPath, renderMarkdown(report));
  }

  if (hasFlag("--check") && report.status !== "passed") {
    throw new Error(
      `CAPITAL_HFT_COMPATIBILITY_FAILED failures=${report.failures
        .map((item) => `${item.preferred}<->${item.legacy}`)
        .join(",")}`,
    );
  }

  if (hasFlag("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    [
      "OpenClaw Capital capital-hft compatibility",
      `status=${report.status}`,
      `capitalHftScriptCount=${report.summary.capitalHftScriptCount}`,
      `requiredAliasCount=${report.summary.requiredAliasCount}`,
      `mismatchCount=${report.summary.mismatchCount}`,
      `nextSafeTask=${report.nextSafeTask}`,
    ].join("\n") + "\n",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  main().catch((error) => {
    process.stderr.write(
      `capital capital-hft compatibility failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

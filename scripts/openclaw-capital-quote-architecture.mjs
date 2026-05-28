import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_PACKAGE_SCRIPTS = [
  "capital-hft:quote:check",
  "capital-hft:quote:read",
  "capital-hft:quote:status",
  "capital-hft:quote:status:check",
  "capital-hft:quote:event",
  "capital-hft:quote:event:check",
  "capital-hft:quote:pump",
  "capital-hft:quote:pump:check",
  "capital-hft:quote:validate",
  "capital-hft:quote:architecture",
  "capital-hft:quote:architecture:check",
];

const REQUIRED_FILES = [
  "scripts/openclaw-capital-quote-reader.mjs",
  "scripts/check-capital-quote-reader.mjs",
  "scripts/openclaw-capital-quote-status.mjs",
  "scripts/check-capital-quote-status.mjs",
  "scripts/openclaw-capital-quote-pump.mjs",
  "scripts/check-capital-quote-pump.mjs",
  "scripts/openclaw-capital-quote-runtime-event.mjs",
  "scripts/check-capital-quote-runtime-event.mjs",
  "scripts/validate-capital-quote-state.mjs",
  "skills/capital-quotes/SKILL.md",
  "docs/automation/module-skill-inventory.md",
];

const REQUIRED_SKILL_PHRASES = [
  "Does not log in to 群益.",
  "Does not place orders.",
  "Does not read or store account passwords",
  "Treats stale, blocked, incomplete, or cooldown states as strategy-gate denial.",
  "Emits a runtime event",
];

function defaultStatusPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "quote", "capital-quote-status.json");
}

function defaultEventPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "runtime-events", "capital-quote-latest.json");
}

function defaultReportPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "quote", "capital-quote-architecture-report.json");
}

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function readText(filePath) {
  return fs.readFile(filePath, "utf8");
}

async function readJson(filePath) {
  return JSON.parse(await readText(filePath));
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function safetyFlagsAreReadOnly(value) {
  return (
    value?.readOnly === true &&
    value?.loginAttempted === false &&
    value?.liveTradingEnabled === false &&
    value?.writeTradingEnabled === false
  );
}

function eventTypeForStatus(status) {
  switch (status) {
    case "ready":
      return "capital.quote.ready";
    case "stale":
      return "capital.quote.stale";
    case "blocked_1115":
      return "capital.quote.blocked_1115";
    case "blocked":
      return "capital.quote.blocked";
    case "incomplete":
      return "capital.quote.incomplete";
    default:
      return "capital.quote.degraded";
  }
}

function addCheck(checks, id, passed, message, evidence = {}) {
  checks.push({
    id,
    status: passed ? "pass" : "fail",
    message,
    evidence,
  });
}

async function loadOptionalJson(filePath, required, checks, id) {
  if (!(await exists(filePath))) {
    addCheck(
      checks,
      id,
      !required,
      required
        ? `Required generated state is missing: ${filePath}`
        : `Generated state not present: ${filePath}`,
      { path: filePath },
    );
    return undefined;
  }
  try {
    const value = await readJson(filePath);
    addCheck(checks, id, true, `Loaded generated state: ${filePath}`, { path: filePath });
    return value;
  } catch (error) {
    addCheck(checks, id, false, `Invalid generated state JSON: ${filePath}`, {
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export async function buildCapitalQuoteArchitectureReport(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const statusPath = path.resolve(options.statusPath ?? defaultStatusPath(repoRoot));
  const eventPath = path.resolve(options.eventPath ?? defaultEventPath(repoRoot));
  const requireGeneratedState = options.requireGeneratedState === true;
  const checks = [];

  const packagePath = path.join(repoRoot, "package.json");
  const packageJson = await readJson(packagePath);
  for (const scriptName of REQUIRED_PACKAGE_SCRIPTS) {
    addCheck(
      checks,
      `package-script:${scriptName}`,
      typeof packageJson.scripts?.[scriptName] === "string",
      `package.json exposes ${scriptName}`,
      { script: packageJson.scripts?.[scriptName] ?? "" },
    );
  }

  for (const relativePath of REQUIRED_FILES) {
    const filePath = path.join(repoRoot, relativePath);
    addCheck(
      checks,
      `file:${relativePath}`,
      await exists(filePath),
      `Required quote architecture file exists: ${relativePath}`,
      {
        path: filePath,
      },
    );
  }

  const skillPath = path.join(repoRoot, "skills", "capital-quotes", "SKILL.md");
  const skillText = (await exists(skillPath)) ? await readText(skillPath) : "";
  for (const phrase of REQUIRED_SKILL_PHRASES) {
    addCheck(
      checks,
      `skill-guardrail:${phrase}`,
      skillText.includes(phrase),
      `capital-quotes skill keeps guardrail: ${phrase}`,
    );
  }

  const status = await loadOptionalJson(
    statusPath,
    requireGeneratedState,
    checks,
    "state:capital-quote-status",
  );
  const event = await loadOptionalJson(
    eventPath,
    requireGeneratedState,
    checks,
    "state:capital-quote-event",
  );

  if (status) {
    addCheck(
      checks,
      "status:schema",
      status.schema === "openclaw.capital.quote-status.v1",
      "Quote status schema is stable",
      {
        schema: status.schema ?? "",
      },
    );
    addCheck(
      checks,
      "status:safety",
      safetyFlagsAreReadOnly(status),
      "Quote status remains read-only and no-login/no-trading",
    );
    addCheck(
      checks,
      "status:strategy-gate",
      status.status !== "ready" || status.strategyGate?.ready === true,
      "Ready status requires strategyGate.ready=true",
      { status: status.status ?? "", strategyGateReady: status.strategyGate?.ready === true },
    );
  }

  if (event) {
    addCheck(
      checks,
      "event:schema",
      event.schema === "openclaw.runtime.event.v1",
      "Runtime event schema is stable",
      {
        schema: event.schema ?? "",
      },
    );
    addCheck(
      checks,
      "event:safety",
      safetyFlagsAreReadOnly(event),
      "Runtime event remains read-only and no-login/no-trading",
    );
    const summaryStatus = event.summary?.status ?? "";
    addCheck(
      checks,
      "event:type",
      event.eventType === eventTypeForStatus(summaryStatus),
      "Runtime event type matches status",
      {
        eventType: event.eventType ?? "",
        summaryStatus,
      },
    );
  }

  if (status && event) {
    const summaryStatus = event.summary?.status ?? "";
    addCheck(
      checks,
      "closed-loop:status-match",
      status.status === summaryStatus,
      "Status file and runtime event status match",
      {
        status: status.status ?? "",
        eventStatus: summaryStatus,
      },
    );
    addCheck(
      checks,
      "closed-loop:strategy-gate-match",
      (status.strategyGate?.ready === true) === (event.summary?.strategyGateReady === true),
      "Status file and runtime event strategy gate match",
      {
        statusStrategyGateReady: status.strategyGate?.ready === true,
        eventStrategyGateReady: event.summary?.strategyGateReady === true,
      },
    );
    addCheck(
      checks,
      "closed-loop:latest-stock-match",
      (status.quoteProof?.latestStock ?? "") === (event.summary?.latestStock ?? ""),
      "Status file and runtime event latest stock match",
      {
        statusLatestStock: status.quoteProof?.latestStock ?? "",
        eventLatestStock: event.summary?.latestStock ?? "",
      },
    );
  }

  const failedChecks = checks.filter((check) => check.status !== "pass");
  const statusValue = failedChecks.length === 0 ? "passed" : "failed";

  return {
    schema: "openclaw.capital.quote-architecture-report.v1",
    generatedAt: new Date().toISOString(),
    status: statusValue,
    readOnlyArchitecture: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    summary: {
      passed: checks.length - failedChecks.length,
      failed: failedChecks.length,
      requiredScripts: REQUIRED_PACKAGE_SCRIPTS.length,
      requiredFiles: REQUIRED_FILES.length,
      generatedStateRequired: requireGeneratedState,
      statusState: status?.status ?? "",
      eventType: event?.eventType ?? "",
      strategyGateReady: event?.summary?.strategyGateReady === true,
      latestStock: event?.summary?.latestStock ?? status?.quoteProof?.latestStock ?? "",
    },
    checks,
    files: {
      packageJson: packagePath,
      statusPath,
      eventPath,
      reportPath: path.resolve(options.outputPath ?? defaultReportPath(repoRoot)),
    },
    nextSafeTask:
      statusValue === "passed"
        ? "把架構 gate 納入 heartbeat/check 流程；維持只讀，不重跑全商品。"
        : "先修復 failed checks；不得啟動 API 登入或交易寫入。",
  };
}

export async function writeCapitalQuoteArchitectureReport(report, outputPath) {
  const text = `${JSON.stringify(report, null, 2)}\n`;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, text, "utf8");
  await fs.writeFile(`${outputPath}.sha256`, `${sha256Text(text)}\n`, "ascii");
  return outputPath;
}

function parseArgs(argv) {
  const options = {
    repoRoot: process.cwd(),
    statusPath: "",
    eventPath: "",
    outputPath: "",
    writeState: false,
    json: false,
    requireGeneratedState: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      options.repoRoot = argv[++index] ?? options.repoRoot;
    } else if (arg.startsWith("--repo-root=")) {
      options.repoRoot = arg.slice("--repo-root=".length);
    } else if (arg === "--status") {
      options.statusPath = argv[++index] ?? options.statusPath;
    } else if (arg.startsWith("--status=")) {
      options.statusPath = arg.slice("--status=".length);
    } else if (arg === "--event") {
      options.eventPath = argv[++index] ?? options.eventPath;
    } else if (arg.startsWith("--event=")) {
      options.eventPath = arg.slice("--event=".length);
    } else if (arg === "--output") {
      options.outputPath = argv[++index] ?? options.outputPath;
    } else if (arg.startsWith("--output=")) {
      options.outputPath = arg.slice("--output=".length);
    } else if (arg === "--write-state") {
      options.writeState = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--require-generated-state") {
      options.requireGeneratedState = true;
    }
  }
  return options;
}

function formatSummary(report, outputPath) {
  return [
    "OpenClaw Capital quote architecture",
    `status=${report.status}`,
    `passed=${report.summary.passed}`,
    `failed=${report.summary.failed}`,
    `eventType=${report.summary.eventType || "N/A"}`,
    `strategyGateReady=${report.summary.strategyGateReady}`,
    `latestStock=${report.summary.latestStock || "N/A"}`,
    outputPath ? `report=${outputPath}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(options.repoRoot);
  const outputPath = path.resolve(options.outputPath || defaultReportPath(repoRoot));
  const report = await buildCapitalQuoteArchitectureReport({
    repoRoot,
    statusPath: options.statusPath || undefined,
    eventPath: options.eventPath || undefined,
    outputPath,
    requireGeneratedState: options.requireGeneratedState,
  });
  const writtenPath = options.writeState
    ? await writeCapitalQuoteArchitectureReport(report, outputPath)
    : "";

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ...report, outputPath: writtenPath }, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatSummary(report, writtenPath)}\n`);
  }

  if (report.status !== "passed") {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `capital quote architecture check failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

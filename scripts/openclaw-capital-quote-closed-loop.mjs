import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCapitalQuoteArchitectureReport } from "./openclaw-capital-quote-architecture.mjs";
import {
  buildCapitalQuoteRuntimeEvent,
  writeCapitalQuoteRuntimeEvent,
} from "./openclaw-capital-quote-runtime-event.mjs";
import { readCapitalQuoteStatus } from "./openclaw-capital-quote-status.mjs";

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

function defaultOutputPath(repoRoot) {
  return path.join(repoRoot, ".openclaw", "quote", "capital-quote-closed-loop.json");
}

function defaultEventDir(repoRoot) {
  return path.join(repoRoot, ".openclaw", "runtime-events");
}

function toTaipeiLocalDate(date) {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000);
}

function fromTaipeiLocalParts(year, month, day, hour, minute = 0, second = 0) {
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute, second));
}

function nextTradingOpenAt(now = new Date()) {
  const taipeiNow = toTaipeiLocalDate(now);
  const candidates = [];
  for (let offsetDays = 0; offsetDays <= 8; offsetDays += 1) {
    const dayLocal = new Date(taipeiNow.getTime() + offsetDays * 24 * 60 * 60 * 1000);
    const dayOfWeek = dayLocal.getUTCDay();
    if (dayOfWeek >= 1 && dayOfWeek <= 5) {
      const year = dayLocal.getUTCFullYear();
      const month = dayLocal.getUTCMonth() + 1;
      const day = dayLocal.getUTCDate();
      candidates.push(fromTaipeiLocalParts(year, month, day, 8, 45, 0));
      candidates.push(fromTaipeiLocalParts(year, month, day, 15, 0, 0));
    }
  }
  const future = candidates.filter((candidate) => candidate.getTime() > now.getTime());
  if (future.length === 0) {
    return null;
  }
  future.sort((a, b) => a.getTime() - b.getTime());
  return future[0];
}

function isClosedSessionSafe(status) {
  return (
    status?.status === "stale" &&
    status?.ready === false &&
    status?.session?.tradingOpen === false &&
    status?.quoteProof?.freshnessStatus === "stale" &&
    status?.bridge?.ready === true &&
    status?.bridge?.brokerActionRequired === false &&
    !status?.bridge?.currentBlockingCode
  );
}

function decideLifecycle(status) {
  if (status?.ready === true && status?.status === "ready") {
    return {
      lifecycleStatus: "ready_live",
      lifecycleReason: "報價處於 ready/fresh，可直接使用。",
    };
  }
  if (isClosedSessionSafe(status)) {
    return {
      lifecycleStatus: "blocked_closed_session_safe",
      lifecycleReason: "休市 + stale 安全阻擋，屬正常保護，不是故障。",
    };
  }
  return {
    lifecycleStatus: "blocked_runtime_issue",
    lifecycleReason: "非休市安全阻擋，需進一步修復 bridge/事件/代碼映射。",
  };
}

function parseArgs(argv) {
  const options = {
    repoRoot: process.cwd(),
    dashboardPath: "",
    outputPath: "",
    eventDir: "",
    writeState: true,
    json: false,
    allowClosedSession: true,
    requireReady: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--repo-root") {
      options.repoRoot = argv[++index] ?? options.repoRoot;
    } else if (arg.startsWith("--repo-root=")) {
      options.repoRoot = arg.slice("--repo-root=".length);
    } else if (arg === "--dashboard") {
      options.dashboardPath = argv[++index] ?? options.dashboardPath;
    } else if (arg.startsWith("--dashboard=")) {
      options.dashboardPath = arg.slice("--dashboard=".length);
    } else if (arg === "--output") {
      options.outputPath = argv[++index] ?? options.outputPath;
    } else if (arg.startsWith("--output=")) {
      options.outputPath = arg.slice("--output=".length);
    } else if (arg === "--event-dir") {
      options.eventDir = argv[++index] ?? options.eventDir;
    } else if (arg.startsWith("--event-dir=")) {
      options.eventDir = arg.slice("--event-dir=".length);
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--no-write-state") {
      options.writeState = false;
    } else if (arg === "--allow-closed-session") {
      options.allowClosedSession = true;
    } else if (arg === "--no-allow-closed-session") {
      options.allowClosedSession = false;
    } else if (arg === "--require-ready") {
      options.requireReady = true;
    }
  }
  return options;
}

export async function evaluateCapitalQuoteClosedLoop(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const dashboardPath =
    typeof options.dashboardPath === "string" && options.dashboardPath.trim().length > 0
      ? path.resolve(options.dashboardPath)
      : undefined;
  const outputPath = path.resolve(options.outputPath || defaultOutputPath(repoRoot));
  const eventDir = path.resolve(options.eventDir || defaultEventDir(repoRoot));
  const allowClosedSession = options.allowClosedSession !== false;
  const requireReady = options.requireReady === true;

  const status = await readCapitalQuoteStatus({
    repoRoot,
    dashboardPath,
  });
  const event = buildCapitalQuoteRuntimeEvent(status);
  const eventFiles = await writeCapitalQuoteRuntimeEvent(event, eventDir);
  const architectureReport = await buildCapitalQuoteArchitectureReport({
    repoRoot,
    requireGeneratedState: true,
  });
  const lifecycle = decideLifecycle(status);
  const architecturePassed = architectureReport.status === "passed";
  const lifecycleAllowed =
    lifecycle.lifecycleStatus === "ready_live" ||
    (allowClosedSession && lifecycle.lifecycleStatus === "blocked_closed_session_safe");
  const readyRequiredSatisfied = !requireReady || lifecycle.lifecycleStatus === "ready_live";
  const pass = architecturePassed && lifecycleAllowed && readyRequiredSatisfied;
  const nextOpenAt = nextTradingOpenAt(new Date());
  const secondsToNextOpen = nextOpenAt
    ? Math.max(0, Math.floor((nextOpenAt.getTime() - Date.now()) / 1000))
    : -1;

  const result = {
    schema: "openclaw.capital.quote-closed-loop.v1",
    generatedAt: new Date().toISOString(),
    repoRoot,
    readOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    pass,
    allowClosedSession,
    requireReady,
    lifecycleStatus: lifecycle.lifecycleStatus,
    lifecycleReason: lifecycle.lifecycleReason,
    status: {
      status: status.status,
      ready: status.ready,
      strategyGateReady: status.strategyGate?.ready,
      freshnessStatus: status.quoteProof?.freshnessStatus ?? "",
      freshnessAgeSeconds: status.quoteProof?.freshnessAgeSeconds ?? -1,
      latestStock: status.quoteProof?.latestStock ?? "",
      session: status.session?.marketSessionLabel ?? "",
      sessionOpen: Boolean(status.session?.tradingOpen),
    },
    architecture: {
      status: architectureReport.status,
      passed: architectureReport.summary?.passed ?? 0,
      failed: architectureReport.summary?.failed ?? 0,
      failedChecks: architectureReport.checks
        .filter((item) => item.status !== "pass")
        .map((item) => item.id),
    },
    runtimeEvent: {
      eventType: event.eventType,
      latestPath: eventFiles.latestPath,
      streamPath: eventFiles.streamPath,
    },
    sessionWindow: {
      nextTradingOpenAt: nextOpenAt ? nextOpenAt.toISOString() : "",
      secondsToNextTradingOpen: secondsToNextOpen,
    },
    nextSafeTask:
      lifecycle.lifecycleStatus === "ready_live"
        ? "維持 heartbeat 監控並持續驗證 freshness。"
        : lifecycle.lifecycleStatus === "blocked_closed_session_safe"
          ? `等待開盤後接收 fresh tick，再驗證 ready（nextOpen=${nextOpenAt ? nextOpenAt.toISOString() : "unknown"}）。`
          : "先修復 brokerActionRequired/currentBlockingCode 或 quote event mapping。",
    outputPath,
  };

  if (options.writeState !== false) {
    const text = `${JSON.stringify(result, null, 2)}\n`;
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, text, "utf8");
    await fs.writeFile(`${outputPath}.sha256`, `${sha256Text(text)}\n`, "ascii");
  }

  return result;
}

function formatSummary(result) {
  return [
    "OpenClaw Capital quote closed-loop",
    `pass=${result.pass}`,
    `lifecycle=${result.lifecycleStatus}`,
    `status=${result.status.status}`,
    `ready=${result.status.ready}`,
    `freshness=${result.status.freshnessStatus}`,
    `session=${result.status.session || "N/A"}`,
    `nextOpenAt=${result.sessionWindow.nextTradingOpenAt || "unknown"}`,
    `secondsToNextOpen=${result.sessionWindow.secondsToNextTradingOpen}`,
    `architecture=${result.architecture.status}`,
    `failedChecks=${result.architecture.failedChecks.join(",") || "none"}`,
    `nextSafeTask=${result.nextSafeTask}`,
  ].join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await evaluateCapitalQuoteClosedLoop(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatSummary(result)}\n`);
  }
  if (!result.pass) {
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `capital quote closed-loop failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

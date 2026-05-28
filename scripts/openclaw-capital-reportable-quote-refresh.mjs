import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCapitalHftStateDir } from "./lib/capital-hft-state-dir.mjs";
import {
  buildCapitalCallbackFreshnessDiagnosis,
  writeCapitalCallbackFreshnessDiagnosis,
} from "./openclaw-capital-callback-freshness-diagnosis.mjs";
import {
  buildCapitalReportableQuoteState,
  writeCapitalReportableQuoteState,
} from "./openclaw-capital-reportable-quote-state.mjs";
import { readCapitalServiceStatus } from "./openclaw-capital-service-status.mjs";

const DEFAULT_DIAGNOSIS_OUTPUT = path.join(
  process.cwd(),
  ".openclaw",
  "quote",
  "capital-callback-freshness-diagnosis.json",
);
const DEFAULT_REPORTABLE_OUTPUT = path.join(
  process.cwd(),
  ".openclaw",
  "quote",
  "capital-reportable-quote-state.json",
);

function parseArgs(argv) {
  const options = {
    capitalHftRoot: "",
    diagnosisOutput: DEFAULT_DIAGNOSIS_OUTPUT,
    reportableOutput: DEFAULT_REPORTABLE_OUTPUT,
    maxAgeMs: 45000,
    writeState: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--state-dir" || arg === "--capital-hft-root") {
      options.capitalHftRoot = argv[++index] ?? "";
    } else if (arg.startsWith("--state-dir=")) {
      options.capitalHftRoot = arg.slice("--state-dir=".length);
    } else if (arg.startsWith("--capital-hft-root=")) {
      options.capitalHftRoot = arg.slice("--capital-hft-root=".length);
    } else if (arg === "--diagnosis-output") {
      options.diagnosisOutput = argv[++index] ?? options.diagnosisOutput;
    } else if (arg.startsWith("--diagnosis-output=")) {
      options.diagnosisOutput = arg.slice("--diagnosis-output=".length);
    } else if (arg === "--reportable-output") {
      options.reportableOutput = argv[++index] ?? options.reportableOutput;
    } else if (arg.startsWith("--reportable-output=")) {
      options.reportableOutput = arg.slice("--reportable-output=".length);
    } else if (arg === "--max-age-ms") {
      options.maxAgeMs = Number(argv[++index] ?? options.maxAgeMs);
    } else if (arg.startsWith("--max-age-ms=")) {
      options.maxAgeMs = Number(arg.slice("--max-age-ms=".length));
    } else if (arg === "--write-state") {
      options.writeState = true;
    } else if (arg === "--json") {
      options.json = true;
    }
  }
  if (!Number.isFinite(options.maxAgeMs) || options.maxAgeMs <= 0) {
    options.maxAgeMs = 45000;
  }
  return options;
}

function runNodeScript(scriptPath, args, { cwd }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
    child.on("error", (error) => {
      resolve({ exitCode: 1, stdout, stderr: error.message });
    });
  });
}

function parseJsonOutput(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

function extractMissingFile(stderr) {
  const text = String(stderr ?? "");
  const openMatch = /open '([^']+)'/u.exec(text);
  if (openMatch?.[1]) {
    return openMatch[1];
  }
  const pathMatch = /path:\s*'([^']+)'/u.exec(text);
  return pathMatch?.[1] ?? "";
}

export function classifyReadbackFailure(readback) {
  const stderr = String(readback?.stderr ?? "");
  if (stderr.includes("ENOENT")) {
    return {
      blockerCode: "subscription_guard_launcher_missing",
      failedSteps: ["callback_readback", "subscription_guard_check"],
      failureCategory: "missing_required_launcher_file",
      missingFile: extractMissingFile(stderr),
      recommendedAction: "修復或還原 subscription guard 指向的啟動檔後再重跑；不可用舊報價補值。",
    };
  }
  return {
    blockerCode: "callback_readback_failed",
    failedSteps: ["callback_readback"],
    failureCategory: "callback_readback_runtime_error",
    missingFile: "",
    recommendedAction: "修復 callback readback 執行失敗後再產生可回報報價狀態。",
  };
}

function blockedCategories(state) {
  return state.blockedQuotes.reduce((counts, item) => {
    const key = item.blockedCategory || "blocked_unknown";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function eventTimestampMs(event) {
  const parsed = Date.parse(event?.brokerMarketTime ?? event?.receivedAt ?? "");
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function eventAgeMs(event, nowMs) {
  const parsed = eventTimestampMs(event);
  return Number.isFinite(parsed) ? Math.max(0, nowMs - parsed) : null;
}

function serviceRuntimeBlocker(serviceStatus) {
  const livenessStatus = serviceStatus?.service?.livenessStatus || "";
  if (livenessStatus === "dead_pid") {
    return {
      blockerCode: "capital_hft_service_dead_pid",
      failedStep: "service_liveness:dead_pid",
    };
  }
  if (livenessStatus === "stale_status") {
    return {
      blockerCode: "capital_hft_service_status_stale",
      failedStep: "service_liveness:stale_status",
    };
  }
  if (livenessStatus === "missing_status") {
    return {
      blockerCode: "capital_hft_service_status_missing",
      failedStep: "service_liveness:missing_status",
    };
  }
  if (livenessStatus === "missing_pid") {
    return {
      blockerCode: "capital_hft_service_pid_missing",
      failedStep: "service_liveness:missing_pid",
    };
  }
  return null;
}

function serviceLivenessSummary(serviceStatus) {
  if (!serviceStatus?.service) {
    return {
      available: false,
      ready: false,
      livenessStatus: "unknown",
      blockerCode: "capital_hft_service_status_unknown",
    };
  }
  const blocker = serviceRuntimeBlocker(serviceStatus);
  return {
    available: true,
    ready: serviceStatus.service.ready === true,
    livenessStatus: serviceStatus.service.livenessStatus ?? "unknown",
    blockerCode: blocker?.blockerCode ?? null,
    pid: serviceStatus.service.pid ?? null,
    pidAlive: serviceStatus.service.pidAlive ?? null,
    statusGeneratedAt: serviceStatus.service.statusGeneratedAt ?? "",
    statusAgeSeconds: serviceStatus.service.statusAgeSeconds ?? null,
    statusFresh: serviceStatus.service.statusFresh ?? null,
  };
}

export function summarizeCallbackStream(reportable, nowMs = Date.now()) {
  const reportableQuotes = Array.isArray(reportable?.reportableQuotes)
    ? reportable.reportableQuotes
    : [];
  const blockedQuotes = Array.isArray(reportable?.blockedQuotes) ? reportable.blockedQuotes : [];
  const allQuotes = [...reportableQuotes, ...blockedQuotes];
  const events = allQuotes
    .map((quote) => ({
      quote,
      event: quote.lastEvent ?? quote,
      timestampMs: eventTimestampMs(quote.lastEvent ?? quote),
    }))
    .filter((item) => Number.isFinite(item.timestampMs))
    .toSorted((a, b) => b.timestampMs - a.timestampMs);
  const latest = events[0] ?? null;
  const staleQuotes = blockedQuotes.filter((quote) =>
    String(quote.blockedCategory ?? "").includes("stale"),
  );
  const missingQuotes = blockedQuotes.filter((quote) => {
    const category = String(quote.blockedCategory ?? "");
    return category === "missing_readback_item" || category === "no_callback_event";
  });
  const sourceFileCounts = {};
  for (const item of events) {
    const sourceFile = item.event?.sourceFile || "unknown";
    sourceFileCounts[sourceFile] = (sourceFileCounts[sourceFile] ?? 0) + 1;
  }
  return {
    state:
      reportableQuotes.length > 0
        ? "fresh_reportable_available"
        : staleQuotes.length > 0
          ? "stale_callbacks_only"
          : missingQuotes.length > 0
            ? "missing_callbacks"
            : "no_reportable_callbacks",
    latestEventSymbol: latest?.event?.stockNo ?? latest?.quote?.symbol ?? null,
    latestEventSource: latest?.quote?.source ?? null,
    latestEventReceivedAt: latest?.event?.receivedAt ?? null,
    latestEventAgeMs: latest ? eventAgeMs(latest.event, nowMs) : null,
    staleSymbolCount: uniqueValues(staleQuotes.map((quote) => quote.symbol)).length,
    missingSymbolCount: uniqueValues(missingQuotes.map((quote) => quote.symbol)).length,
    staleSymbols: uniqueValues(staleQuotes.map((quote) => quote.symbol)),
    missingSymbols: uniqueValues(missingQuotes.map((quote) => quote.symbol)),
    sourceFileCounts,
  };
}

function deriveBlockerCode({ reportable, readbackExitCode, readbackJson, serviceStatus }) {
  if (Array.isArray(reportable?.reportableQuotes) && reportable.reportableQuotes.length > 0) {
    return null;
  }
  const serviceBlocker = serviceRuntimeBlocker(serviceStatus);
  if (serviceBlocker) {
    return serviceBlocker.blockerCode;
  }
  const staleOrMissingCount = Number(readbackJson?.summary?.staleOrMissingCount);
  if (readbackExitCode === 2 && Number.isFinite(staleOrMissingCount) && staleOrMissingCount > 0) {
    return "callback_stream_stale_or_missing";
  }
  return "no_fresh_matched_reportable_quote";
}

function deriveFailedSteps({ blockerCode, serviceStatus }) {
  const serviceBlocker = serviceRuntimeBlocker(serviceStatus);
  if (serviceBlocker?.blockerCode === blockerCode) {
    return [serviceBlocker.failedStep, "callback_stream_freshness"];
  }
  if (blockerCode === "callback_stream_stale_or_missing") {
    return ["callback_stream_freshness"];
  }
  if (blockerCode === "no_fresh_matched_reportable_quote") {
    return ["reportable_quote_match"];
  }
  return [];
}

function isDomesticQuote(item) {
  return item?.source === "domestic";
}

function sessionClosedReason(serviceStatus) {
  return serviceStatus?.quote?.reason || "國內期貨目前非交易時段，沒有 fresh tick 可回報。";
}

function sessionClosedBlockedQuoteFromReportable(quote, serviceStatus) {
  return {
    symbol: quote.query || quote.symbol,
    source: quote.source,
    diagnosis: "session_closed",
    blockedCategory: "session_closed",
    reason: sessionClosedReason(serviceStatus),
    unblockCondition: "等待國內期貨交易時段恢復並回流 fresh callback。",
    recommendedAction: "盤間或休市不可回舊價；等 fresh tick 後重新產生 reportable quote state。",
    lastEvent: {
      stockNo: quote.symbol,
      stockName: quote.name,
      receivedAt: quote.receivedAt,
      timeBasis: quote.timeBasis,
      brokerMarketTime: quote.brokerMarketTime,
      close: quote.close,
      bid: quote.bid,
      ask: quote.ask,
      sourceFile: quote.sourceFile,
      ageMs: quote.ageMs ?? null,
      maxAgeMs: quote.maxAgeMs ?? null,
    },
  };
}

function sessionClosedBlockedQuoteFromBlocked(quote, serviceStatus) {
  return {
    ...quote,
    diagnosis: "session_closed",
    blockedCategory: "session_closed",
    reason: sessionClosedReason(serviceStatus),
    unblockCondition: "等待國內期貨交易時段恢復並回流 fresh callback。",
    recommendedAction: "盤間或休市不可回舊價；等 fresh tick 後重新產生 reportable quote state。",
  };
}

export function applySessionClosedToReportableState(state, serviceStatus) {
  if (serviceStatus?.quote?.status !== "session_closed") {
    return state;
  }
  const reportableQuotes = Array.isArray(state?.reportableQuotes) ? state.reportableQuotes : [];
  const blockedQuotes = Array.isArray(state?.blockedQuotes) ? state.blockedQuotes : [];
  const stillReportable = reportableQuotes.filter((quote) => !isDomesticQuote(quote));
  const sessionClosedReportable = reportableQuotes
    .filter(isDomesticQuote)
    .map((quote) => sessionClosedBlockedQuoteFromReportable(quote, serviceStatus));
  const updatedBlocked = [
    ...blockedQuotes
      .filter((quote) => !isDomesticQuote(quote))
      .map((quote) => Object.assign({}, quote)),
    ...blockedQuotes
      .filter(isDomesticQuote)
      .map((quote) => sessionClosedBlockedQuoteFromBlocked(quote, serviceStatus)),
    ...sessionClosedReportable,
  ];
  const blockedCategoryCounts = updatedBlocked.reduce((counts, quote) => {
    const key = quote.blockedCategory || "blocked_unknown";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
  return {
    ...state,
    status: updatedBlocked.length === 0 ? "ready" : "partial_ready",
    sessionStatus: "session_closed",
    summary: {
      ...state.summary,
      reportableCount: stillReportable.length,
      blockedCount: updatedBlocked.length,
      blockedCategoryCounts,
    },
    reportableQuotes: stillReportable,
    blockedQuotes: updatedBlocked,
    nextSafeTask: "等待國內期貨交易時段恢復並回流 fresh callback；期間不可回舊價。",
  };
}

export async function refreshCapitalReportableQuoteState(options = {}) {
  const repoRoot = path.resolve(options.repoRoot || process.cwd());
  const capitalHftRoot = path.resolve(options.capitalHftRoot || resolveCapitalHftStateDir());
  const readbackScript = path.join(capitalHftRoot, "openclaw-capital-callback-readback.mjs");
  const diagnosisOutput = path.resolve(options.diagnosisOutput || DEFAULT_DIAGNOSIS_OUTPUT);
  const reportableOutput = path.resolve(options.reportableOutput || DEFAULT_REPORTABLE_OUTPUT);
  const maxAgeMs = Number.isFinite(Number(options.maxAgeMs)) ? Number(options.maxAgeMs) : 45000;
  const readback = await runNodeScript(
    readbackScript,
    ["--json", "--max-age-ms", String(maxAgeMs)],
    {
      cwd: capitalHftRoot,
    },
  );
  const readbackJson = parseJsonOutput(readback.stdout);
  const toleratedReadbackExit = readback.exitCode === 0 || readback.exitCode === 2;
  if (!toleratedReadbackExit) {
    const failure = classifyReadbackFailure(readback);
    return {
      schema: "openclaw.capital.reportable-quote-refresh.v1",
      generatedAt: new Date().toISOString(),
      readOnly: true,
      loginAttempted: false,
      liveTradingEnabled: false,
      writeTradingEnabled: false,
      sentOrder: false,
      sentSubscribeCommand: false,
      status: "blocked",
      blockerCode: failure.blockerCode,
      failedSteps: failure.failedSteps,
      failureCategory: failure.failureCategory,
      missingFile: failure.missingFile,
      steps: {
        readback: {
          ok: false,
          exitCode: readback.exitCode,
          stderr: readback.stderr.trim(),
          script: readbackScript,
        },
      },
      summary: {
        reportableCount: 0,
        blockedCount: 0,
        blockedCategoryCounts: {},
      },
      nextSafeTask: failure.recommendedAction,
    };
  }

  const diagnosis = await buildCapitalCallbackFreshnessDiagnosis({
    repoRoot,
    capitalHftRoot,
  });
  const writtenDiagnosis = await writeCapitalCallbackFreshnessDiagnosis(diagnosis, diagnosisOutput);
  const rawReportable = await buildCapitalReportableQuoteState({ diagnosis: diagnosisOutput });
  const serviceStatus = await readCapitalServiceStatus({
    repoRoot,
    capitalRoot: capitalHftRoot,
  }).catch(() => null);
  const reportable = applySessionClosedToReportableState(rawReportable, serviceStatus);
  const callbackStream = summarizeCallbackStream(reportable);
  const blockerCode = deriveBlockerCode({
    reportable,
    readbackExitCode: readback.exitCode,
    readbackJson,
    serviceStatus,
  });
  const writtenReportable = options.writeState
    ? await writeCapitalReportableQuoteState(reportable, reportableOutput)
    : "";

  return {
    schema: "openclaw.capital.reportable-quote-refresh.v1",
    generatedAt: new Date().toISOString(),
    readOnly: true,
    loginAttempted: false,
    liveTradingEnabled: false,
    writeTradingEnabled: false,
    sentOrder: false,
    sentSubscribeCommand: false,
    status: reportable.status,
    blockerCode,
    failedSteps: deriveFailedSteps({ blockerCode, serviceStatus }),
    quotePolicy: reportable.quotePolicy,
    steps: {
      readback: {
        ok: true,
        exitCode: readback.exitCode,
        script: readbackScript,
        outJson: readbackJson?.summary
          ? path.join(capitalHftRoot, "state", "capital_callback_readback_latest.json")
          : "",
        reportableCount: readbackJson?.summary?.reportableCount ?? null,
        staleOrMissingCount: readbackJson?.summary?.staleOrMissingCount ?? null,
      },
      diagnosis: {
        ok: true,
        status: diagnosis.status,
        outputPath: writtenDiagnosis,
      },
      reportable: {
        ok: true,
        status: reportable.status,
        outputPath: writtenReportable,
      },
    },
    summary: {
      ...reportable.summary,
      blockedCategoryCounts: blockedCategories(reportable),
    },
    serviceLiveness: serviceLivenessSummary(serviceStatus),
    callbackStream,
    reportableQuotes: reportable.reportableQuotes,
    blockedQuotes: reportable.blockedQuotes,
    nextSafeTask: reportable.nextSafeTask,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await refreshCapitalReportableQuoteState(options);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  process.stdout.write(
    [
      "OpenClaw Capital reportable quote refresh",
      `status=${report.status}`,
      `blockerCode=${report.blockerCode ?? "none"}`,
      `reportable=${report.summary.reportableCount}`,
      `blocked=${report.summary.blockedCount}`,
    ].join("\n") + "\n",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `capital reportable quote refresh failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}

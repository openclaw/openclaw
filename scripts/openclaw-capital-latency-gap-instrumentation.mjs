import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCapitalHftStateDir } from "./lib/capital-hft-state-dir.mjs";

const SCHEMA = "openclaw.capital.latency-gap-instrumentation.v1";

function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex").toUpperCase();
}

async function writeTextWithSha(filePath, text) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, text, "utf8");
  await fs.writeFile(`${filePath}.sha256`, `${sha256Text(text)}\n`, "ascii");
}

async function writeJsonWithSha(filePath, value) {
  await writeTextWithSha(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error?.code)) {
      return "";
    }
    throw error;
  }
}

async function readJsonIfExists(filePath) {
  const text = await readTextIfExists(filePath);
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/u, ""));
  } catch {
    return null;
  }
}

async function readTailLines(filePath, byteCount = 262_144) {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const stat = await handle.stat();
    const length = Math.min(byteCount, stat.size);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stat.size - length);
    return buffer
      .toString("utf8")
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EISDIR"].includes(error?.code)) {
      return [];
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function count(text, needle) {
  return text.split(needle).length - 1;
}

function latestJsonLine(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // Keep scanning older lines.
    }
  }
  return null;
}

function buildStaticEvidence(serviceText, riskGateText, latencyText, gapText) {
  const checks = {
    latencyMonitorClassPresent: latencyText.includes("internal class LatencyMonitor"),
    latencyHelpersPresent:
      serviceText.includes("private long BeginLatencyTiming()") &&
      serviceText.includes("private void RecordLatencyFrom(string stage, long startTick)"),
    strategyRunnerLatencyLinked: serviceText.includes(
      "_strategyRunner.GetPerformanceTracker().SetLatencyMonitor(_latency);",
    ),
    latencyApiStages:
      serviceText.includes('"tick_to_signal"') &&
      serviceText.includes('"signal_to_order"') &&
      serviceText.includes('"order_round_trip"'),
    tickToSignalRecordedOnBothFeeds: count(serviceText, 'RecordLatencyFrom("tick_to_signal"') >= 2,
    signalToOrderRecorded: serviceText.includes(
      'RecordLatencyFrom("signal_to_order", signalToOrderStartTick);',
    ),
    orderRoundTripRecorded: count(serviceText, 'RecordLatencyFrom("order_round_trip"') >= 6,
    gapDetectorClassPresent: gapText.includes("internal class GapDetector"),
    lastPriceFeedsGapDetector: serviceText.includes(
      "_gapDetector.UpdateLastPrice(stockNo, price);",
    ),
    preTradeRiskBlocksGapPause: riskGateText.includes("_gapDetector.IsGapPause(sym)"),
  };
  return {
    status: Object.values(checks).every(Boolean) ? "wired" : "incomplete",
    checks,
    counts: {
      tickToSignalRecordCalls: count(serviceText, 'RecordLatencyFrom("tick_to_signal"'),
      signalToOrderRecordCalls: count(serviceText, 'RecordLatencyFrom("signal_to_order"'),
      orderRoundTripRecordCalls: count(serviceText, 'RecordLatencyFrom("order_round_trip"'),
    },
  };
}

function toMarkdown(report) {
  const rows = Object.entries(report.staticEvidence.checks).map(
    ([key, value]) => `| ${key} | ${value ? "OK" : "FAIL"} |`,
  );
  return [
    "# Capital latency / gap instrumentation",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- status: ${report.status}`,
    `- capitalRoot: ${report.scope.capitalRoot}`,
    `- liveTradingEnabled: ${report.safety.liveTradingEnabled}`,
    `- writeBrokerOrders: ${report.safety.writeBrokerOrders}`,
    `- sentOrder: ${report.safety.sentOrder}`,
    "",
    "## Static wiring",
    "",
    "| check | status |",
    "|---|---|",
    ...rows,
    "",
    "## Runtime evidence",
    "",
    `- latestSignalAt: ${report.runtimeEvidence.latestSignalAt || "missing"}`,
    `- signalTailCount: ${report.runtimeEvidence.signalTailCount}`,
    `- paperOrderTailCount: ${report.runtimeEvidence.paperOrderTailCount}`,
    `- serviceStatus: ${report.runtimeEvidence.serviceStatus || "missing"}`,
    "",
    "## Result",
    "",
    report.status === "passed"
      ? "Latency/GAP instrumentation is wired and broker write remains disabled."
      : `Blocked: ${report.blockers.join(", ")}`,
    "",
  ].join("\n");
}

function parseArgs(argv) {
  return {
    writeState: argv.includes("--write-state") || argv.includes("--check"),
    json: argv.includes("--json"),
    check: argv.includes("--check"),
  };
}

export async function buildCapitalLatencyGapInstrumentation(options = {}) {
  const repoRoot = path.resolve(options.repoRoot ?? process.cwd());
  const capitalRoot = path.resolve(options.capitalRoot ?? resolveCapitalHftStateDir());
  const serviceText = await readTextIfExists(path.join(capitalRoot, "CapitalHftService.cs"));
  const riskGateText = await readTextIfExists(path.join(capitalRoot, "PreTradeRiskGate.cs"));
  const latencyText = await readTextIfExists(path.join(capitalRoot, "LatencyMonitor.cs"));
  const gapText = await readTextIfExists(path.join(capitalRoot, "GapDetector.cs"));
  const serviceStatus = await readJsonIfExists(path.join(capitalRoot, "hft_service_status.json"));
  const signalTail = await readTailLines(path.join(capitalRoot, "hft_strategy_signals.jsonl"));
  const paperTail = await readTailLines(path.join(capitalRoot, "hft_paper_orders.jsonl"));
  const latestSignal = latestJsonLine(signalTail);

  const staticEvidence = buildStaticEvidence(serviceText, riskGateText, latencyText, gapText);
  const safety = {
    liveTradingEnabled: serviceStatus?.riskControls?.allowLiveTrading === true,
    writeBrokerOrders: serviceStatus?.riskControls?.writeBrokerOrders === true,
    sentOrder: false,
    paperOnlyProof:
      serviceStatus?.riskControls?.allowLiveTrading === false &&
      serviceStatus?.riskControls?.writeBrokerOrders === false,
  };
  const runtimeEvidence = {
    serviceStatus: serviceStatus?.status ?? null,
    latestSignalAt: latestSignal?.ts ?? latestSignal?.generatedAt ?? null,
    latestSignalSymbol: latestSignal?.symbol ?? null,
    signalTailCount: signalTail.length,
    paperOrderTailCount: paperTail.length,
  };
  const blockers = [];
  if (staticEvidence.status !== "wired") {
    blockers.push("latency-gap-static-wiring-incomplete");
  }
  if (safety.liveTradingEnabled) {
    blockers.push("live-trading-enabled");
  }
  if (safety.writeBrokerOrders) {
    blockers.push("broker-write-enabled");
  }
  if (runtimeEvidence.signalTailCount === 0) {
    blockers.push("strategy-signal-evidence-missing");
  }
  if (runtimeEvidence.paperOrderTailCount === 0) {
    blockers.push("paper-order-evidence-missing");
  }

  return {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    status: blockers.length === 0 ? "passed" : "blocked",
    scope: { repoRoot, capitalRoot },
    staticEvidence,
    runtimeEvidence,
    safety,
    blockers,
    nextSafeTask:
      blockers.length === 0
        ? "下一步完成 Overseas product rotation beyond 64 SKOS slots；仍不得啟用 live API、broker write 或真單。"
        : "先修 LatencyMonitor / GapDetector static wiring；仍不得啟用 live API、broker write 或真單。",
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildCapitalLatencyGapInstrumentation({ repoRoot: process.cwd() });
  const jsonPath = path.join(
    process.cwd(),
    "reports",
    "hermes-agent",
    "state",
    "openclaw-capital-latency-gap-instrumentation-latest.json",
  );
  const mdPath = path.join(
    process.cwd(),
    "reports",
    "hermes-agent",
    "state",
    "openclaw-capital-latency-gap-instrumentation-latest.md",
  );
  const docPath = path.join(
    process.cwd(),
    "docs",
    "automation",
    "capital-api-latency-gap-instrumentation.md",
  );
  const markdown = toMarkdown(report);
  if (options.writeState) {
    await writeJsonWithSha(jsonPath, report);
    await writeTextWithSha(mdPath, markdown);
    await writeTextWithSha(docPath, markdown);
  }
  if (options.check && report.status !== "passed") {
    throw new Error(`CAPITAL_LATENCY_GAP_INSTRUMENTATION_BLOCKED ${report.blockers.join(",")}`);
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(markdown);
  }
}

const invokedPath = fileURLToPath(import.meta.url);
if (process.argv[1] === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

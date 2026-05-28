/**
 * openclaw-quote-diagnostics.mjs
 * 檢查 CapitalHftService 連線、quote feed 狀態、stale quote 原因
 * 用法: node scripts/openclaw-quote-diagnostics.mjs [--write-state] [--json]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..");
const CAPITAL_HFT = "D:\\群益及元大API\\CapitalHftService";
const CAPITAL_HFT_STATE = path.join(
  CAPITAL_HFT,
  ".openclaw",
  "ui",
  "capital-hft-service-state.json",
);
const CAPITAL_HFT_QUOTE = path.join(CAPITAL_HFT, "capital_latest_quote_event.json");
const CAPITAL_HFT_EVENTS = path.join(CAPITAL_HFT, "capital_quote_events.jsonl");
const BROKER_STATE_FALLBACK = "D:\\群益及元大API\\CapitalHftService\\state";
const DATA_ROOT = path.resolve(ROOT, "..", "OpenClawData");

async function fileAge(p) {
  try {
    const stat = await fs.stat(p);
    return {
      exists: true,
      ageMs: Date.now() - stat.mtimeMs,
      mtime: stat.mtime.toISOString(),
      sizeBytes: stat.size,
    };
  } catch {
    return { exists: false, ageMs: Infinity, mtime: "", sizeBytes: 0 };
  }
}

async function readJsonSafe(p) {
  try {
    return JSON.parse(await fs.readFile(p, "utf8"));
  } catch {
    return null;
  }
}

export async function diagnoseQuoteFeed(options = {}) {
  const now = new Date();
  const checks = [];

  // 1. CapitalHftService 服務狀態
  const hftSvc = await readJsonSafe(CAPITAL_HFT_STATE);
  if (hftSvc) {
    const running = hftSvc.running === true;
    const login = hftSvc.loginStatus === "connected";
    const quoteMon = hftSvc.quoteMonitorConnected === true;
    checks.push({
      id: "capital_hft_service",
      status: running && login && quoteMon ? "pass" : "fail",
      message:
        "running=" +
        running +
        " login=" +
        login +
        " quoteMon=" +
        quoteMon +
        " pid=" +
        (hftSvc.pid || "?") +
        " subscribed=[" +
        (hftSvc.subscribedStocks || []).join(",") +
        "]",
    });
    if (hftSvc.quoteStats) {
      const lastAt = hftSvc.quoteStats.lastQuoteAt;
      const lastMs =
        lastAt && lastAt !== "N/A" ? Date.now() - new Date(lastAt).getTime() : Infinity;
      checks.push({
        id: "capital_hft_quote_stats",
        status: lastMs < 300000 ? "pass" : lastMs < 3600000 ? "warn" : "fail",
        message:
          "ticks=" +
          hftSvc.quoteStats.tickCount +
          " quotes=" +
          hftSvc.quoteStats.quoteCount +
          " best5=" +
          hftSvc.quoteStats.best5Count +
          " lastAt=" +
          lastAt +
          " (" +
          Math.round(lastMs / 60000) +
          "min ago)",
      });
    }
    if (hftSvc.riskControls) {
      checks.push({
        id: "capital_hft_risk",
        status: "info",
        message:
          "allowLive=" +
          hftSvc.riskControls.allowLiveTrading +
          " writeBroker=" +
          hftSvc.riskControls.writeBrokerOrders +
          " maxPos=" +
          hftSvc.riskControls.maxPositionContracts,
      });
    }
  } else {
    checks.push({
      id: "capital_hft_service",
      status: "fail",
      message: "CapitalHftService state not found",
    });
  }

  // 2. 最新報價事件
  const latestQuote = await fileAge(CAPITAL_HFT_QUOTE);
  if (latestQuote.exists && latestQuote.ageMs < 300000) {
    checks.push({
      id: "quote_freshness",
      status: "pass",
      message:
        "quote event " +
        Math.round(latestQuote.ageMs / 1000) +
        "s ago (" +
        latestQuote.sizeBytes +
        "B)",
    });
  } else if (latestQuote.exists) {
    checks.push({
      id: "quote_freshness",
      status: "warn",
      message: "quote event stale: " + Math.round(latestQuote.ageMs / 60000) + "min ago",
    });
  } else {
    const fbQuote = await fileAge(
      path.join(BROKER_STATE_FALLBACK, "capital_latest_quote_event.json"),
    );
    if (fbQuote.exists) {
      checks.push({
        id: "quote_freshness",
        status: fbQuote.ageMs < 300000 ? "pass" : "warn",
        message: "[fallback CapitalHftService] " + Math.round(fbQuote.ageMs / 60000) + "min ago",
      });
    } else {
      checks.push({ id: "quote_freshness", status: "fail", message: "no quote event files found" });
    }
  }

  // 3. 報價事件流
  const eventsAge = await fileAge(CAPITAL_HFT_EVENTS);
  if (eventsAge.exists) {
    checks.push({
      id: "quote_event_stream",
      status: eventsAge.ageMs < 300000 ? "pass" : "warn",
      message:
        "events.jsonl " +
        (eventsAge.sizeBytes / 1024 / 1024).toFixed(1) +
        "MB, " +
        Math.round(eventsAge.ageMs / 60000) +
        "min ago",
    });
  }

  // 4. Risk controls
  const rc = await readJsonSafe(path.join(DATA_ROOT, "trading", "risk_controls.json"));
  if (rc) {
    checks.push({
      id: "risk_controls",
      status: "pass",
      message: "allow_live=" + rc.allow_live + ", daily_loss=" + rc.daily_loss_limit_pct + "%",
    });
    if (rc.block_on_stale_quotes) {
      checks.push({
        id: "stale_quote_block",
        status: "warn",
        message: "block_on_stale_quotes=true",
      });
    }
  }

  // 5. Gate report
  const csGate = await readJsonSafe(
    path.join(
      ROOT,
      "reports",
      "hermes-agent",
      "state",
      "openclaw-capital-live-risk-monitor-gate-latest.json",
    ),
  );
  if (csGate) {
    const gMsg =
      "Live risk monitor: " + csGate.status + " (" + (csGate.blockerCode || "none") + ")";
    checks.push({ id: "live_risk_gate", status: csGate.status, message: gMsg });
  }

  const hasBlock = checks.some((c) => c.status === "fail");
  const hasWarn = checks.some((c) => c.status === "warn");

  const diagnosis = {
    schema: "openclaw.quote-diagnostics.v2",
    generatedAt: now.toISOString(),
    status: hasBlock ? "blocked" : hasWarn ? "degraded" : "healthy",
    checks,
    capitalHftServicePath: CAPITAL_HFT,
    recommendations: [],
  };

  if (hasBlock) {
    diagnosis.recommendations.push("Check CapitalHftService.exe is running");
    diagnosis.recommendations.push(
      "Launch: D:\\\\群益及元大API\\\\CapitalHftService\\\\out\\\\CapitalHftService.exe",
    );
    diagnosis.recommendations.push("Verify SKCOM login and quote subscription");
  }
  if (hasWarn) {
    diagnosis.recommendations.push("Quote delay above threshold, check network and subscription");
    diagnosis.recommendations.push(
      "Verify CapitalHftService subscribedStocks includes TX00, MTX00",
    );
  }

  if (options.writeState) {
    const reportPath = path.join(
      ROOT,
      "reports",
      "hermes-agent",
      "state",
      "quote-diagnostics-latest.json",
    );
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(diagnosis, null, 2) + "\n");
  }

  return diagnosis;
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const d = await diagnoseQuoteFeed({ writeState: process.argv.includes("--write-state") });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(d, null, 2));
  } else {
    console.log("[" + d.status.toUpperCase() + "] Quote Diagnostics");
    for (const c of d.checks) {
      console.log("  [" + c.status + "] " + c.id + ": " + c.message);
    }
    if (d.recommendations.length) {
      console.log("\nRecommendations:");
      d.recommendations.forEach((r) => console.log("  - " + r));
    }
  }
}

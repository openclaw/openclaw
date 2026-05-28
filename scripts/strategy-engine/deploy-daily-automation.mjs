#!/usr/bin/env node
/**
 * deploy-daily-automation.mjs
 * node deploy-daily-automation.mjs [--dry-run] [--json] [--live]
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..", "..");
const STATE_DIR = path.join(ROOT, "data", "automation_state");
const args = new Set(process.argv.slice(2));
const isDryRun = args.has("--dry-run");
const isJson = args.has("--json");
const isLive = args.has("--live");

async function preflight() {
  try {
    const res = await fetch("http://localhost:8765/api/status");
    const status = await res.json();
    const ok = status.loginStatus === "connected" && status.quoteMonitorConnected === true;
    // cert 為選用警告，不阻斷啟動
    return {
      ok,
      login: status.loginStatus,
      cert: status.certificateLoaded,
      quote: status.quoteMonitorConnected,
      osQuote: status.osQuoteConnected,
      order: status.orderInitialized,
      domesticTicks: status.quoteStats?.tickCount ?? 0,
      overseasTicks: status.osQuoteStats?.tickCount ?? 0,
      riskControls: status.riskControls,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function main() {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const report = {
    schema: "openclaw.daily-automation-deploy.v1",
    generatedAt: new Date().toISOString(),
    dryRun: isDryRun,
    live: isLive,
  };

  if (!isJson) {
    console.log("=== Preflight Check ===");
  }
  const pf = await preflight();
  report.preflight = pf;
  if (!isJson) {
    console.log("  login: " + pf.login);
    console.log("  cert: " + pf.cert);
    console.log("  quote: " + pf.quote + ", osQuote: " + pf.osQuote);
    console.log("  domesticTicks: " + pf.domesticTicks + ", overseasTicks: " + pf.overseasTicks);
    console.log("  riskControls: " + JSON.stringify(pf.riskControls));
    console.log("  preflight: " + (pf.ok ? "PASS" : "FAIL"));
  }
  if (!pf.ok) {
    report.status = "blocked";
    report.reason = pf.error ?? "preflight_failed";
    output(report);
    return;
  }

  if (!isJson) {
    console.log("\n=== Load Strategy Config ===");
  }
  const configPath = path.join(ROOT, "scripts", "strategy-engine", "config", "strategies.json");
  let config;
  try {
    config = JSON.parse(await fs.readFile(configPath, "utf-8"));
  } catch (e) {
    report.status = "blocked";
    report.reason = "config_load_failed: " + e.message;
    output(report);
    return;
  }
  const enabled = (config.strategies ?? []).filter((s) => s.enabled !== false);
  report.strategiesTotal = config.strategies?.length ?? 0;
  report.strategiesEnabled = enabled.length;
  if (!isJson) {
    console.log("  total: " + report.strategiesTotal + ", enabled: " + report.strategiesEnabled);
  }

  if (isDryRun) {
    report.status = "dry_run_ok";
    report.reason = "preflight passed, config valid, dry-run mode";
    output(report);
    return;
  }

  const mode = isLive ? "LIVE" : "paper";
  if (!isJson) {
    console.log("\n=== Starting Strategy Engine (" + mode + " mode) ===");
  }
  const { StrategyEngine } = await import("./StrategyEngine.mjs");
  const { CapitalAdapter } = await import("./brokers/CapitalAdapter.mjs");
  const { OkxAdapter } = await import("./brokers/OkxAdapter.mjs");
  const { QuoteHub } = await import("./QuoteHub.mjs");

  const adapters = {
    capital: new CapitalAdapter({ mode: isLive ? "live" : "paper" }),
    okx: new OkxAdapter({ mode: isLive ? "live" : "demo" }),
  };
  const engine = new StrategyEngine({ ...config, dryRun: !isLive });
  let loadedCount = 0;
  for (const cfg of enabled) {
    if (!adapters[cfg.broker]) {
      continue;
    }
    try {
      const mod = await import("./strategies/" + cfg.class + ".mjs");
      const Cls = mod[cfg.class] ?? mod.default;
      if (Cls) {
        engine.addStrategy(new Cls(cfg));
        loadedCount++;
      }
    } catch {
      /* skip */
    }
  }
  report.strategiesLoaded = loadedCount;
  if (!isJson) {
    console.log("  loaded: " + loadedCount + " strategies");
  }

  // Sync broker positions
  try {
    const { fetchBrokerPositions, syncPositionsToEngine } = await import("./PositionSync.mjs");
    const bp = fetchBrokerPositions();
    const sr = syncPositionsToEngine(engine, bp);
    report.positionSync = sr;
    if (!isJson) {
      console.log("  positionSync: " + sr.synced + " synced, " + sr.skipped + " skipped");
    }
  } catch (e) {
    if (!isJson) {
      console.log("  positionSync: skipped (" + e.message + ")");
    }
    report.positionSync = { error: e.message };
  }

  const instruments = [...new Set(enabled.map((s) => s.instrument).filter(Boolean))];
  const quoteHub = new QuoteHub({ verbose: false });
  quoteHub.bridgeToFeed(engine.feed);
  await quoteHub.start(instruments);
  if (!isJson) {
    console.log("  QuoteHub: " + instruments.length + " instruments");
  }

  let heartbeatCount = 0;
  const heartbeat = setInterval(() => {
    heartbeatCount++;
    if (!isJson) {
      console.log(
        "  [heartbeat #" +
          heartbeatCount +
          "] quotes=" +
          quoteHub.quoteCount +
          " uptime=" +
          process.uptime().toFixed(0) +
          "s",
      );
    }
  }, 60000);

  report.status = "running";
  report.mode = mode;
  report.startedAt = new Date().toISOString();
  output(report);

  await fs.writeFile(
    path.join(STATE_DIR, "deploy-state-latest.json"),
    JSON.stringify(report, null, 2),
    "utf-8",
  );

  process.on("SIGINT", () => {
    if (!isJson) {
      console.log("\n=== Shutting down ===");
    }
    clearInterval(heartbeat);
    engine.stop();
    quoteHub.stop();
    const final = { ...report, stoppedAt: new Date().toISOString(), heartbeats: heartbeatCount };
    void fs
      .writeFile(
        path.join(STATE_DIR, "deploy-state-latest.json"),
        JSON.stringify(final, null, 2),
        "utf-8",
      )
      .then(
        () => process.exit(0),
        () => process.exit(1),
      );
  });

  await engine.start();
}

function output(r) {
  if (isJson) {
    console.log(JSON.stringify(r, null, 2));
  }
}

main().catch((e) => {
  console.error("Deploy error:", e.message);
  process.exit(1);
});

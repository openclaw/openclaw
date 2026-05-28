#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CapitalAdapter } from "./brokers/CapitalAdapter.mjs";
import { OkxAdapter } from "./brokers/OkxAdapter.mjs";
import { QuoteHub } from "./QuoteHub.mjs";
import { StrategyEngine } from "./StrategyEngine.mjs";

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), "..", "..");
const CONFIG_DIR = path.join(ROOT, "scripts", "strategy-engine", "config");
const args = process.argv.slice(2);
function readArgValue(flag, fallback = null) {
  const index = args.indexOf(flag);
  if (index < 0 || index + 1 >= args.length) {
    return fallback;
  }
  return args[index + 1];
}

const brokerArg = readArgValue("--broker", "all");
const profileArg = readArgValue("--profile", "").trim().toLowerCase();
const dryRun = !args.includes("--no-dry-run");
const isJson = args.includes("--json");
const enableLive = args.includes("--enable-live") && args.includes("--send-live");
const APPROVAL_PATH = path.join(ROOT, "config", "capital-live-trading-approval.json");
const SUPPORTED_BROKERS = ["capital", "okx"];

function resolveRequestedBrokers(strategies, requestedBroker) {
  if (requestedBroker !== "all") {
    return SUPPORTED_BROKERS.includes(requestedBroker) ? new Set([requestedBroker]) : new Set();
  }
  const brokers = new Set();
  for (const strategy of strategies ?? []) {
    if (strategy?.enabled === false) {
      continue;
    }
    const brokerName = String(strategy?.broker ?? "");
    if (SUPPORTED_BROKERS.includes(brokerName)) {
      brokers.add(brokerName);
    }
  }
  if (brokers.size === 0) {
    return new Set(SUPPORTED_BROKERS);
  }
  return brokers;
}

async function loadStrategies() {
  const profilePathMap = {
    futures: "strategies.futures.json",
    tw: "strategies.tw.json",
  };
  const profileConfigFile = profilePathMap[profileArg];
  const fallbackConfigPath = path.join(CONFIG_DIR, "strategies.json");
  const profileConfigPath = profileConfigFile ? path.join(CONFIG_DIR, profileConfigFile) : null;
  const configPath = profileConfigPath ?? fallbackConfigPath;
  try {
    const parsed = JSON.parse(await fs.readFile(configPath, "utf-8"));
    return {
      config: parsed,
      configPath,
      profile: profileArg || "default",
      fallbackUsed: false,
    };
  } catch {
    if (profileConfigPath) {
      try {
        const parsedFallback = JSON.parse(await fs.readFile(fallbackConfigPath, "utf-8"));
        return {
          config: parsedFallback,
          configPath: fallbackConfigPath,
          profile: profileArg || "default",
          fallbackUsed: true,
        };
      } catch {}
    }
  }
  return {
    config: {
      pollMs: 1000,
      dryRun: true,
      strategies: [
        {
          name: "momentum_tx",
          class: "MomentumStrategy",
          instrument: "TX00",
          broker: "capital",
          params: { period: 20, threshold: 0.5 },
        },
        {
          name: "mean_revert_btc",
          class: "MeanReversionStrategy",
          instrument: "BTC-USDT",
          broker: "okx",
          params: { period: 20, zScore: 2.0 },
        },
      ],
    },
    configPath: fallbackConfigPath,
    profile: profileArg || "default",
    fallbackUsed: false,
  };
}

async function main() {
  const loadedConfig = await loadStrategies();
  const config = loadedConfig.config;
  const requestedBrokers = resolveRequestedBrokers(config.strategies, brokerArg);
  let liveApproval = null;
  if (enableLive) {
    try {
      const raw = JSON.parse(await fs.readFile(APPROVAL_PATH, "utf-8"));
      liveApproval = raw.safety ?? null;
      if (!isJson) {
        console.log(
          "Live approval: allowLive=" +
            liveApproval?.allowLiveTrading +
            ", writeBroker=" +
            liveApproval?.writeBrokerOrders,
        );
      }
    } catch (e) {
      console.error("Cannot load live approval: " + e.message);
      process.exit(1);
    }
  }
  const adapterMode = enableLive ? "live" : "paper";
  const adapters = {};
  if (requestedBrokers.has("capital")) {
    adapters.capital = new CapitalAdapter({ mode: adapterMode, liveApproval });
  }
  if (requestedBrokers.has("okx")) {
    adapters.okx = new OkxAdapter({ mode: enableLive ? "live" : "demo", liveApproval });
  }

  const healthReport = {};
  for (const [name, adapter] of Object.entries(adapters)) {
    healthReport[name] = await adapter.isHealthy();
    if (!isJson) {
      console.log((healthReport[name] ? "[ok]" : "[wait]") + " " + adapter.displayName);
    }
  }

  const engine = new StrategyEngine({ ...config, dryRun, pollMs: config.pollMs ?? 1000 });
  const loadedStrategies = [];
  const loadedStrategyConfigs = [];
  for (const stratCfg of config.strategies ?? []) {
    if (stratCfg.enabled === false) {
      continue;
    }
    if (brokerArg !== "all" && stratCfg.broker !== brokerArg) {
      continue;
    }
    if (!adapters[stratCfg.broker]) {
      continue;
    }
    try {
      const mod = await import("./strategies/" + stratCfg.class + ".mjs");
      const Cls = mod[stratCfg.class] ?? mod.default;
      if (!Cls) {
        if (!isJson) {
          console.log("Strategy class not found: " + stratCfg.class);
        }
        continue;
      }
      engine.addStrategy(new Cls(stratCfg));
      loadedStrategies.push(stratCfg.name);
      loadedStrategyConfigs.push(stratCfg);
      if (!isJson) {
        console.log(
          "Loaded: " +
            stratCfg.name +
            " (" +
            stratCfg.class +
            ") -> " +
            stratCfg.broker +
            ":" +
            stratCfg.instrument,
        );
      }
    } catch (e) {
      if (!isJson) {
        console.log("Failed to load " + stratCfg.name + ": " + e.message);
      }
    }
  }

  // ── QuoteHub：毫秒級即時報價（取代舊 polling）──
  let quoteHub = null;
  if (!isJson) {
    const allInstruments = [
      ...new Set(loadedStrategyConfigs.map((s) => s.instrument).filter(Boolean)),
    ];
    quoteHub = new QuoteHub({ verbose: true });
    quoteHub.bridgeToFeed(engine.feed);
    await quoteHub.start(allInstruments);
    console.log(
      `[QuoteHub] Active: ${quoteHub.quoteCount} initial quotes, ${allInstruments.length} instruments`,
    );
  }

  const state = {
    schema: "openclaw.strategy-engine-runner.v1",
    generatedAt: new Date().toISOString(),
    brokers: Object.entries(adapters).map(([k, v]) =>
      Object.assign({ name: k, healthy: healthReport[k] }, v.toJSON()),
    ),
    strategies: loadedStrategies,
    dryRun,
    jsonReadinessOnly: isJson,
    profile: loadedConfig.profile,
    requestedBrokers: [...requestedBrokers],
    strategiesConfigPath: loadedConfig.configPath,
    configFallbackUsed: loadedConfig.fallbackUsed,
    brokerWriteAttempted: false,
    sentOrder: false,
    noLiveOrderSent: true,
    pollMs: config.pollMs ?? 1000,
  };
  if (isJson) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  if (loadedStrategies.length === 0) {
    console.log("No available strategies");
    return;
  }

  console.log(
    "Strategy engine started: " + loadedStrategies.length + " strategies, dryRun=" + dryRun,
  );
  process.on("SIGINT", () => {
    engine.stop();
    if (quoteHub) {
      quoteHub.stop();
    }
    process.exit(0);
  });
  await engine.start();
}

main().catch((e) => {
  console.error("Engine error:", e.message);
  process.exitCode = 1;
});

import fs from "node:fs/promises";
import { CONTRACT_SPECS } from "./brokers/ContractSpecs.mjs";
import { DataFeed } from "./DataFeed.mjs";
import { OrderRouter } from "./OrderRouter.mjs";
import { EquityBridge } from "./risk/EquityBridge.mjs";
import { PositionLifecycleManager } from "./risk/PositionLifecycleManager.mjs";

const EQUITY_SIZER_CONFIG_URL = new URL("./config/equity-sizer-config.json", import.meta.url);

function asPositiveNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function resolveInstrumentRoot(instrument) {
  const normalized = String(instrument ?? "")
    .trim()
    .toUpperCase();
  if (!normalized) {
    return "";
  }
  if (CONTRACT_SPECS[normalized]) {
    return normalized;
  }
  const stripped = normalized.replace(/\d+$/u, "");
  if (stripped && CONTRACT_SPECS[stripped]) {
    return stripped;
  }
  const keys = Object.keys(CONTRACT_SPECS).toSorted((a, b) => b.length - a.length);
  return keys.find((key) => normalized.startsWith(key)) ?? stripped;
}

export class StrategyEngine {
  constructor(config) {
    this.config = config;
    this.strategies = [];
    this.feed = new DataFeed();
    this.router = new OrderRouter(config.dryRun ?? true);
    this._running = false;
    this._pollInterval = config.pollMs ?? 1000;

    // 由 runner 注入（可選）
    this.notifier = null; // NotifyManager
    this.sizer = null; // PositionSizer
    this._dashboard = null; // DashboardServer
    this.riskController = null; // RiskController
    this.fillTracker = null; // FillTracker
    this.correlationMonitor = null; // CorrelationMonitor
    this.logger = null; // LogManager
    this.paperTradingLoop = null; // PaperTradingLoop -- runner inject
    this.equityBridge = null;
    this._equitySizerConfig = config.equitySizer ?? null;
    this.positionLifecycle = new PositionLifecycleManager(config.positionLifecycle ?? {});

    // dedupe
    this._lastSignalKey = new Map();
    this._dedupeMs = config.dedupeMs ?? 5000;

    // correlation update counter
    this._loopCount = 0;
    this._corrUpdateEvery = config.corrUpdateEvery ?? 10;
  }

  addStrategy(strategy) {
    this.strategies.push(strategy);
    this.fillTracker?.registerStrategy(strategy);
    this.feed.subscribe(strategy.instrument, strategy.broker, (event) => {
      if (event.type === "bar") {
        strategy.onBar(event.bar);
      }
      if (event.type === "tick") {
        strategy.onTick?.(event);
      }
    });
  }

  async start() {
    await this._ensureEquityBridge();
    this._running = true;
    const log = this.logger;
    const msg = `Starting ${this.strategies.length} strategies, dryRun=${this.router.dryRun}`;
    if (log) {
      log.info(msg);
    } else {
      console.log(`[StrategyEngine] ${msg}`);
    }
    if (this.riskController) {
      (log ? log.info : console.log)("[StrategyEngine] RiskController mounted");
    }
    if (this.fillTracker) {
      (log ? log.info : console.log)("[StrategyEngine] FillTracker mounted");
    }
    if (this.correlationMonitor) {
      (log ? log.info : console.log)("[StrategyEngine] CorrelationMonitor mounted");
    }
    void this._loop();
  }

  stop() {
    this._running = false;
    this.equityBridge?.stopPolling();
    const msg = "[StrategyEngine] Stopped";
    if (this.logger) {
      this.logger.info(msg);
    } else {
      console.log(msg);
    }
  }

  /**
   * Hot reload entry point (called by ConfigWatcher)
   * @param {object} newConfig
   * @param {object} diff  ConfigWatcher._diff() output
   */
  async hotReload(newConfig, diff) {
    const log = this.logger;
    const info = (m) => (log ? log.info(m) : console.log(`[HotReload] ${m}`));

    info(`Hot reload: +${diff.added.length} -${diff.removed.length} ~${diff.updated.length}`);

    // 1. remove strategies
    for (const name of diff.removed) {
      const idx = this.strategies.findIndex((s) => s.name === name);
      if (idx >= 0) {
        this.strategies[idx].disable();
        this.strategies.splice(idx, 1);
        info(`Removed strategy: ${name}`);
      }
    }

    // 2. update strategy params
    for (const { new: newCfg } of diff.updated) {
      const strat = this.strategies.find((s) => s.name === newCfg.name);
      if (strat) {
        const changes = strat.updateParams(newCfg.params ?? {}, newCfg);
        info(
          `Updated ${newCfg.name}: ${changes.map((c) => `${c.key}:${c.old}->${c.new}`).join(", ")}`,
        );
      }
    }

    // 3. add strategies (dynamic import)
    for (const cfg of diff.added) {
      try {
        const mod = await import(`./strategies/${cfg.class}.mjs`);
        const Cls = mod[cfg.class];
        if (!Cls) {
          info(`Strategy class not found: ${cfg.class}`);
          continue;
        }
        const strat = new Cls(cfg);
        this.addStrategy(strat);
        info(`Added strategy: ${cfg.name} (${cfg.class})`);
      } catch (e) {
        info(`Failed to add strategy ${cfg.name}: ${e.message}`);
      }
    }

    // 4. update global config
    if (diff.globalChanged.pollMs) {
      this._pollInterval = diff.globalChanged.pollMs.new;
      info(`pollMs -> ${this._pollInterval}`);
    }

    // 5. broadcast hot_reload event to Dashboard
    if (this._dashboard) {
      this._dashboard.pushHotReload(diff);
    }

    info(`Hot reload done, strategy count: ${this.strategies.length}`);
    return diff;
  }

  async _loop() {
    while (this._running) {
      this._loopCount++;

      for (const strat of this.strategies) {
        if (!strat._enabled) {
          continue;
        }
        const signals = strat.popSignals();

        for (const sig of signals) {
          const lifecycleResult = this.positionLifecycle.evaluate({
            signal: sig,
            strategy: strat,
          });
          if (!lifecycleResult.allow) {
            this.logger?.info(
              `[Lifecycle] hold ${sig.strategy} ${sig.direction} ${sig.instrument} reason=${lifecycleResult.reason}`,
            );
            continue;
          }
          Object.assign(sig, lifecycleResult.signal);

          // 1. dedupe
          const dedupeKey = `${sig.strategy}_${sig.instrument}_${sig.direction}`;
          const lastTs = this._lastSignalKey.get(dedupeKey) ?? 0;
          if (Date.now() - lastTs < this._dedupeMs) {
            continue;
          }
          this._lastSignalKey.set(dedupeKey, Date.now());

          // 2. position sizing
          if (this.sizer && sig.qty == null) {
            sig.qty = this._calcSignalQty(sig, strat);
          }

          // 3. correlation check
          if (this.correlationMonitor) {
            const corrResult = this.correlationMonitor.check({
              strategy: sig.strategy ?? strat.name,
              direction: sig.direction,
              instrument: sig.instrument,
              qty: sig.qty ?? 1,
            });
            if (!corrResult.ok) {
              const reason = corrResult.reason;
              this.logger?.logRisk("CORR_BLOCK", reason, { sig });
              if (this._dashboard) {
                this._dashboard.pushAlert(`Correlation block: ${reason}`, "warning");
              }
              continue;
            }
            if (corrResult.scaledQty != null && corrResult.scaledQty !== sig.qty) {
              this.logger?.warn(`Correlation scale ${sig.qty}->${corrResult.scaledQty}`, {
                strategy: sig.strategy,
              });
              sig.qty = corrResult.scaledQty;
            }
          }

          // 4. risk gate
          if (this.riskController) {
            const { ok, reason } = this.riskController.check(sig);
            if (!ok) {
              const warnMsg = `Block ${sig.strategy} ${sig.direction} ${sig.instrument}: ${reason}`;
              if (this.logger) {
                this.logger.logRisk("RISK_BLOCK", reason, { sig });
              } else {
                console.warn(`[RiskCtrl] ${warnMsg}`);
              }
              if (this._dashboard) {
                this._dashboard.pushAlert(`Risk block: ${reason}`, "warning");
              }
              continue;
            }
          }

          // 5. notification
          this.logger?.logSignal({ ...sig, strategy: sig.strategy ?? strat.name });
          if (this.notifier) {
            await this.notifier.signal(sig).catch(() => {});
          }
          if (this._dashboard) {
            this._dashboard.pushSignal(sig);
          }

          // 6. route order / paper trade / log
          if (sig.autoExecute || this.config.forceAutoAll) {
            await this.router.routeSignal(sig);

            // 7. paper trade (dryRun -> forward to PaperTradingLoop)
            if (this.router.dryRun && this.paperTradingLoop?.onSignal) {
              await this.paperTradingLoop.onSignal(sig, this.paperTradingLoop.adapter);
            }

            // 8. simulated fill report (dryRun)
            if (this.fillTracker && this.router.dryRun) {
              const bar = strat.lastBar?.();
              const fill = this.fillTracker.simulateFill(sig, bar?.close);
              this.logger?.logFill(fill);

              if (this.correlationMonitor && fill?.pnl != null) {
                this.correlationMonitor.updateReturn(sig.strategy ?? strat.name, fill.pnl);
              }
            }
          } else {
            // non-autoExecute: log but still forward to paper trading
            if (this.router.dryRun && this.paperTradingLoop?.onSignal) {
              await this.paperTradingLoop.onSignal(sig, this.paperTradingLoop.adapter);
            }
            const dir = sig.direction?.toUpperCase() ?? "";
            const icon = dir === "BUY" ? "[UP]" : dir === "SELL" ? "[DN]" : "[SIG]";
            const logLine = `${icon} [SIGNAL] ${sig.strategy} ${dir} ${sig.instrument} qty=${sig.qty} | ${sig.reason}`;
            if (this.logger) {
              this.logger.info(logLine);
            } else {
              console.log(logLine);
            }
          }
        }
      }

      // Dashboard PnL sync
      if (this._dashboard && this.fillTracker) {
        const total = this.fillTracker.getTotalPnl();
        const daily = this.riskController?._dailyPnl ?? total;
        this._dashboard.pushPnl(daily, total);
      }

      // periodic correlation report
      if (this.correlationMonitor && this._loopCount % (this._corrUpdateEvery * 100) === 0) {
        this.correlationMonitor.printReport();
      }

      await new Promise((r) => setTimeout(r, this._pollInterval));
    }
  }

  _calcSignalQty(sig, strat) {
    const ctx = {
      price: sig.price ?? 0,
      bars: strat._priceHistory,
    };
    const instrumentRoot = resolveInstrumentRoot(sig.instrument);
    const specs = instrumentRoot ? (CONTRACT_SPECS[instrumentRoot] ?? null) : null;
    if (!specs) {
      return this.sizer.calc(ctx);
    }

    const equitySizerConfig = this._equitySizerConfig ?? this.config.equitySizer ?? {};
    const isOverseas = specs.currency === "USD";
    const marketConfig = isOverseas ? equitySizerConfig.overseas : equitySizerConfig.domestic;
    const instrumentConfig = equitySizerConfig.instruments?.[instrumentRoot];
    const riskConfig = equitySizerConfig.risk ?? {};
    const resolvedCapital = isOverseas
      ? this.equityBridge?.getOverseasCapital()
      : this.equityBridge?.getDomesticCapital();

    if (asPositiveNumber(resolvedCapital)) {
      this.sizer.updateCapital(resolvedCapital);
    }
    if (asPositiveNumber(specs.pointValue)) {
      this.sizer.pointValue = specs.pointValue;
    }
    if (asPositiveNumber(specs.indicativeMargin)) {
      ctx.margin = specs.indicativeMargin;
    }

    const maxPositionPct =
      asPositiveNumber(instrumentConfig?.maxPositionPct) ??
      asPositiveNumber(marketConfig?.maxPositionPct);
    if (maxPositionPct) {
      ctx.maxPositionPct = maxPositionPct;
    }

    const originalMaxQty = this.sizer.maxQty;
    const originalRiskPct = this.sizer.riskPct;
    const originalStopMult = this.sizer.stopMult;
    const originalRiskPerTradePct = this.sizer.riskPerTradePct;
    const originalMaxMarginUtilPct = this.sizer.maxMarginUtilPct;
    try {
      this._applySizerConfig(marketConfig);
      this._applySizerConfig(instrumentConfig);
      this._applySizerConfig(riskConfig);

      const maxContractsFromApi = this.equityBridge?.getMaxPositionContracts();
      if (asPositiveNumber(maxContractsFromApi)) {
        const apiMaxContracts = Math.floor(maxContractsFromApi);
        this.sizer.maxQty = asPositiveNumber(this.sizer.maxQty)
          ? Math.min(this.sizer.maxQty, apiMaxContracts)
          : apiMaxContracts;
      }
      return this.sizer.calc(ctx);
    } finally {
      this.sizer.maxQty = originalMaxQty;
      this.sizer.riskPct = originalRiskPct;
      this.sizer.stopMult = originalStopMult;
      this.sizer.riskPerTradePct = originalRiskPerTradePct;
      this.sizer.maxMarginUtilPct = originalMaxMarginUtilPct;
    }
  }

  _applySizerConfig(config) {
    if (!config || typeof config !== "object") {
      return;
    }
    const riskPct = asPositiveNumber(config.riskPct);
    if (riskPct) {
      this.sizer.riskPct = riskPct;
    }
    const maxContracts = asPositiveNumber(config.maxContracts);
    if (maxContracts) {
      this.sizer.maxQty = Math.floor(maxContracts);
    }
    const stopMultiple = asPositiveNumber(config.stopMultiple);
    if (stopMultiple) {
      this.sizer.stopMult = stopMultiple;
    }
    const riskPerTradePct = asPositiveNumber(config.riskPerTradePct);
    if (riskPerTradePct) {
      this.sizer.riskPerTradePct = riskPerTradePct;
    }
    const maxMarginUtilPct = asPositiveNumber(config.maxMarginUtilPct);
    if (maxMarginUtilPct) {
      this.sizer.maxMarginUtilPct = maxMarginUtilPct;
    }
  }

  async _ensureEquityBridge() {
    if (this.equityBridge) {
      return;
    }
    const config = await this._loadEquitySizerConfig();
    this._equitySizerConfig = config ?? {};
    this.config.equitySizer = this._equitySizerConfig;
    const lifecycleConfig =
      this._equitySizerConfig.lifecycle ?? this.config.positionLifecycle ?? {};
    this.positionLifecycle = new PositionLifecycleManager(lifecycleConfig);
    this.equityBridge = new EquityBridge(this._equitySizerConfig);
    this.equityBridge.startPolling(this._equitySizerConfig.pollIntervalMs);
  }

  async _loadEquitySizerConfig() {
    if (this.config.equitySizer && typeof this.config.equitySizer === "object") {
      return this.config.equitySizer;
    }
    try {
      const raw = await fs.readFile(EQUITY_SIZER_CONFIG_URL, "utf-8");
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }
}

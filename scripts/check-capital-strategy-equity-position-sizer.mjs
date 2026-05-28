import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EquityBridge } from "./strategy-engine/risk/EquityBridge.mjs";
import { PositionSizer } from "./strategy-engine/risk/PositionSizer.mjs";
import { StrategyEngine } from "./strategy-engine/StrategyEngine.mjs";

async function checkEquityBridge() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-equity-bridge-"));
  const domesticRightsPath = path.join(tmpDir, "hft_rights.json");
  const overseasRightsPath = path.join(tmpDir, "hft_os_rights.json");

  await fs.writeFile(
    domesticRightsPath,
    JSON.stringify({
      rights: 0,
      availableBalance: 0,
      margin: 12345,
      generatedAt: "2026-05-26T10:00:00.000Z",
    }),
    "utf8",
  );
  await fs.writeFile(
    overseasRightsPath,
    JSON.stringify({
      rights: 25000,
      availableBalance: 10000,
      margin: 5000,
      generatedAt: "2026-05-26T10:00:05.000Z",
    }),
    "utf8",
  );

  const bridge = new EquityBridge({
    domesticRightsPath,
    overseasRightsPath,
    fallbackEquity: 500000,
    fallbackOsEquity: 20000,
    statusUrl: "http://127.0.0.1:1/api/status",
  });
  await bridge.refresh();
  const equity = bridge.getEquity();

  assert.equal(equity.domestic.rights, 500000);
  assert.equal(equity.domestic.source, "fallback");
  assert.equal(equity.overseas.rights, 25000);
  assert.equal(equity.overseas.source, "broker");
  assert.equal(bridge.getDomesticCapital(), 500000);
  assert.equal(bridge.getOverseasCapital(), 25000);
  return {
    domesticCapital: bridge.getDomesticCapital(),
    overseasCapital: bridge.getOverseasCapital(),
  };
}

function checkPositionSizerMarginCap() {
  const sizer = new PositionSizer({
    method: "atr",
    capital: 100000,
    pointValue: 1,
    riskPct: 0.05,
    stopMult: 1,
    minQty: 1,
    maxQty: 50,
  });

  const qty = sizer.calc({
    atr: 10,
    price: 1000,
    margin: 20000,
    maxPositionPct: 0.2,
  });

  assert.equal(qty, 1);
  return qty;
}

function createBars() {
  return Array.from({ length: 20 }, (_unused, index) => {
    const close = 15700 + index * 5;
    return {
      high: close + 20,
      low: close - 20,
      close,
    };
  });
}

function checkStrategyEngineSizerIntegration() {
  const engine = new StrategyEngine({
    dryRun: true,
    pollMs: 1000,
    equitySizer: {
      domestic: { riskPct: 0.02, maxContracts: 10, maxPositionPct: 0.25 },
      overseas: { riskPct: 0.03, maxContracts: 8, maxPositionPct: 0.3 },
      instruments: {
        CN: { riskPct: 0.03, maxContracts: 8 },
      },
    },
  });

  engine.sizer = new PositionSizer({
    method: "atr",
    capital: 1000000,
    pointValue: 1,
    riskPct: 0.01,
    stopMult: 1.5,
    minQty: 1,
    maxQty: 20,
  });
  engine.equityBridge = {
    getOverseasCapital: () => 20000,
    getDomesticCapital: () => 500000,
    getMaxPositionContracts: () => 8,
  };

  const qty = engine._calcSignalQty(
    { instrument: "CN0000", price: 15785, direction: "BUY", strategy: "equity-check" },
    { _priceHistory: createBars() },
  );

  assert.ok(qty >= 1 && qty <= 8);
  assert.equal(engine.sizer.capital, 20000);
  assert.equal(engine.sizer.riskPct, 0.01);
  assert.equal(engine.sizer.maxQty, 20);
  return {
    qty,
    capital: engine.sizer.capital,
  };
}

export async function collectCapitalStrategyEquityPositionSizerChecks() {
  const equity = await checkEquityBridge();
  const marginCappedQty = checkPositionSizerMarginCap();
  const strategy = checkStrategyEngineSizerIntegration();
  return {
    ok: true,
    checks: [
      {
        id: "equity_bridge_fallback",
        status: "pass",
        domesticCapital: equity.domesticCapital,
        overseasCapital: equity.overseasCapital,
      },
      {
        id: "position_sizer_margin_cap",
        status: "pass",
        qty: marginCappedQty,
      },
      {
        id: "strategy_engine_equity_integration",
        status: "pass",
        qty: strategy.qty,
        capital: strategy.capital,
      },
    ],
  };
}

export async function runCapitalStrategyEquityPositionSizerCheck(options = {}) {
  const io = options.io ?? {
    stdout: process.stdout,
    stderr: process.stderr,
  };
  try {
    const report = await collectCapitalStrategyEquityPositionSizerChecks();
    io.stdout.write(
      `CAPITAL_STRATEGY_EQUITY_POSITION_SIZER_CHECK=${report.ok ? "OK" : "FAIL"} checks=${report.checks.length}\n`,
    );
    for (const check of report.checks) {
      io.stdout.write(`[${check.status.toUpperCase()}] ${check.id}\n`);
    }
    return report.ok ? 0 : 1;
  } catch (error) {
    io.stderr.write(
      `capital strategy equity position sizer check failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const exitCode = await runCapitalStrategyEquityPositionSizerCheck();
  process.exitCode = exitCode;
}

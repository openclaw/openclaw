/**
 * check-capital-strategy-engine.mjs
 *
 * Gate check：驗證策略引擎能正確從 tick 流產生信號
 * 輸出：CAPITAL_STRATEGY_ENGINE_CHECK=OK signals=N orb=N vwap=N
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCapitalHftStateDir } from "./lib/capital-hft-state-dir.mjs";
import { resolveCapitalStrategySymbol } from "./lib/capital-strategy-symbol-resolver.mjs";
import { runStrategyEngine } from "./openclaw-capital-strategy-engine.mjs";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const repoRoot = path.resolve(currentDir, "..");
const blockedLegacyStrategySymbols = new Set(["TX00AM", "TX00PM", "TX06AM", "TX06PM"]);

async function main() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "strategy-engine-check-"));

  try {
    // 使用真實 tick 資料路徑
    const hftStateDir = process.env.CAPITAL_HFT_STATE_DIR ?? resolveCapitalHftStateDir();
    const realTicksPath = path.join(hftStateDir, "capital_quote_events.jsonl");

    let ticksPath = realTicksPath;
    let usingFixture = false;

    // 如果沒有真實資料，使用測試 fixture
    try {
      await fs.access(realTicksPath);
    } catch {
      // 建立最小 fixture：TX00 ticks（可以建立 ORB 信號）
      ticksPath = path.join(tmpDir, "fixture_quote_events.jsonl");
      const now = new Date();
      const fixture = [];
      // 模擬 08:46 開始的 ticks（台灣時間），UTC 偏移 -8h
      const baseTs = new Date(now);
      baseTs.setUTCHours(0);
      baseTs.setUTCMinutes(46); // 08:46 TWT = 00:46 UTC

      const prices = [
        40000, 39800, 40200, 39750, 40100, 40300, 40500, 40250, 40150, 40080, 40020, 39950,
      ];
      for (let i = 0; i < prices.length; i++) {
        const ts = new Date(baseTs.getTime() + i * 2 * 60 * 1000); // 每2分鐘
        fixture.push(
          JSON.stringify({
            schema: "capital-hft.capital.quote-event.v1",
            stockNo: "TX00",
            eventSource: "SKQuoteLib.OnNotifyQuoteLONG",
            decimal: "0",
            close: String(prices[i]),
            bid: String(prices[i] - 1),
            ask: String(prices[i] + 1),
            qty: "1",
            receivedAt: ts.toISOString(),
          }),
        );
      }
      await fs.writeFile(ticksPath, fixture.join("\n") + "\n", "utf8");
      usingFixture = true;
    }

    const result = await runStrategyEngine({
      repoRoot,
      ticksPath,
      intentsPath: path.join(tmpDir, "intents.jsonl"),
      reportPath: path.join(tmpDir, "report.json"),
      symbol: usingFixture ? "TX00" : "tx-front",
      resolveSymbol: !usingFixture,
    });
    const blockedLegacyIntentsPath = path.join(tmpDir, "blocked-legacy-intents.jsonl");
    const blockedLegacyReportPath = path.join(tmpDir, "blocked-legacy-report.json");
    await fs.writeFile(
      blockedLegacyIntentsPath,
      `${JSON.stringify({
        schema: "openclaw.capital.paper-intent.v2",
        intentId: "previous-active-intent",
        intentRunId: "previous-active-run",
        symbol: "TX00",
        paperOnly: true,
        allowLiveTrading: false,
        writeBrokerOrders: false,
      })}\n`,
      "utf8",
    );
    const blockedLegacyResult = await runStrategyEngine({
      repoRoot,
      ticksPath,
      intentsPath: blockedLegacyIntentsPath,
      reportPath: blockedLegacyReportPath,
      symbol: "TX00AM",
    });
    const legacyAliasProbe = await resolveCapitalStrategySymbol({
      query: "TX00AM",
      repoRoot,
      stateDir: hftStateDir,
    });
    const routerFixtureStatePath = path.join(tmpDir, "contract-router-reportable-state.json");
    await fs.writeFile(
      routerFixtureStatePath,
      `${JSON.stringify({
        schema: "openclaw.capital.reportable-quote-state.v1",
        status: "ready",
        reportableQuotes: [
          {
            query: "TX07AM",
            symbol: "TX07AM",
            source: "domestic",
            close: 41750,
            bid: 41749,
            ask: 41751,
            receivedAt: "2026-05-21T12:23:14.1749817+08:00",
            sourceFile: "capital_quote_events.jsonl",
          },
        ],
        blockedQuotes: [],
      })}\n`,
      "utf8",
    );
    const nextMonthRouteProbe = await resolveCapitalStrategySymbol({
      query: "TXF next-month",
      repoRoot,
      reportableState: routerFixtureStatePath,
      now: "2026-05-21T04:23:17.841Z",
    });

    // 驗證
    const issues = [];
    if (!result.schema || !result.schema.startsWith("openclaw.capital.strategy-signal")) {
      issues.push("schema 無效");
    }
    if (!result.stats || typeof result.stats.totalTicks !== "number") {
      issues.push("stats.totalTicks 無效");
    }
    if (typeof result.stats.barsBuilt !== "number") {
      issues.push("stats.barsBuilt 無效");
    }
    if (result.safetyLock?.allowLiveTrading !== false) {
      issues.push("安全鎖 allowLiveTrading 應為 false");
    }
    if (result.safetyLock?.writeBrokerOrders !== false) {
      issues.push("安全鎖 writeBrokerOrders 應為 false");
    }
    if (
      result.readOnly !== true ||
      result.loginAttempted !== false ||
      result.liveTradingEnabled !== false ||
      result.writeTradingEnabled !== false ||
      result.brokerOrderPathEnabled !== false
    ) {
      issues.push(
        `頂層安全欄位錯誤：${JSON.stringify({
          readOnly: result.readOnly,
          loginAttempted: result.loginAttempted,
          liveTradingEnabled: result.liveTradingEnabled,
          writeTradingEnabled: result.writeTradingEnabled,
          brokerOrderPathEnabled: result.brokerOrderPathEnabled,
        })}`,
      );
    }
    if (blockedLegacyStrategySymbols.has(String(result.symbol ?? "").toUpperCase())) {
      issues.push(
        `strategy engine active symbol must not be a legacy session alias：${JSON.stringify({
          symbol: result.symbol,
          quoteSymbol: result.quoteSymbol,
        })}`,
      );
    }
    if (legacyAliasProbe.status !== "invalid_legacy_session_alias") {
      issues.push(`TX00AM 應被策略 resolver 阻擋：${JSON.stringify(legacyAliasProbe)}`);
    }
    if (
      nextMonthRouteProbe.ok !== true ||
      nextMonthRouteProbe.resolvedSymbol !== "TX07AM" ||
      nextMonthRouteProbe.contractRoute?.routingMode !== "next-month" ||
      nextMonthRouteProbe.contractRoute?.selectedSymbols?.includes("TX06AM") ||
      nextMonthRouteProbe.contractRoute?.selectedSymbols?.includes("TX00AM")
    ) {
      issues.push(
        `TXF next-month 策略 resolver 必須透過月份路由解析到 TX07AM：${JSON.stringify(nextMonthRouteProbe)}`,
      );
    }
    if (
      blockedLegacyResult.status !== "blocked_symbol_not_ready" ||
      blockedLegacyResult.resolver?.status !== "invalid_legacy_session_alias"
    ) {
      issues.push(`TX00AM 必須被 strategy engine 阻擋：${JSON.stringify(blockedLegacyResult)}`);
    }
    if (blockedLegacyResult.symbol === "TX00AM" || blockedLegacyResult.symbol === "TX06AM") {
      issues.push(
        `blocked legacy alias 不得成為 active strategy symbol：${JSON.stringify(blockedLegacyResult)}`,
      );
    }
    if (
      blockedLegacyResult.stats?.intentsWritten !== 0 ||
      blockedLegacyResult.stats?.signalsGenerated !== 0
    ) {
      issues.push(
        `blocked legacy alias 不得產生 signals/intents：${JSON.stringify(blockedLegacyResult.stats)}`,
      );
    }
    const blockedLegacyActiveText = await fs.readFile(blockedLegacyIntentsPath, "utf8");
    if (blockedLegacyActiveText.trim() !== "") {
      issues.push("blocked legacy alias 必須清空 active intents");
    }
    if (
      blockedLegacyResult.intentLifecycle?.status !== "rejected" ||
      blockedLegacyResult.intentLifecycle?.reason !== "blocked_symbol_not_ready" ||
      blockedLegacyResult.intentLifecycle?.previousRecordCount !== 1 ||
      !blockedLegacyResult.intentLifecycle?.previousDigest
    ) {
      issues.push(
        `blocked legacy alias 必須封存 rejected epoch：${JSON.stringify(blockedLegacyResult.intentLifecycle)}`,
      );
    }
    const rejectedLatestPath = path.join(tmpDir, "blocked-legacy-intents-rejected-latest.json");
    const rejectedLatest = JSON.parse(await fs.readFile(rejectedLatestPath, "utf8"));
    if (
      rejectedLatest.schema !== "openclaw.capital.paper-intent-epoch.v1" ||
      rejectedLatest.previousRecordCount !== 1 ||
      rejectedLatest.safetyLock?.allowLiveTrading !== false
    ) {
      issues.push(`rejected latest epoch malformed：${JSON.stringify(rejectedLatest)}`);
    }
    const leakedLegacyAlias = result.resolver?.diagnostic?.aliasStates?.find((aliasState) =>
      blockedLegacyStrategySymbols.has(String(aliasState?.symbol ?? "").toUpperCase()),
    );
    if (leakedLegacyAlias) {
      issues.push(
        `策略 resolver diagnostic 不應輸出 legacy session alias：${JSON.stringify(leakedLegacyAlias)}`,
      );
    }
    // 確認至少能處理 ticks（即使無信號也是正常）
    if (result.status === "no_ticks" && !usingFixture) {
      issues.push("無法讀取 tick 資料");
    }
    if (!usingFixture && result.source?.liveCallbackSource !== true) {
      issues.push("策略引擎未使用 CapitalHftService callback tick 來源");
    }
    const safeHistoricalSnapshot =
      !usingFixture &&
      ["historical_no_signals", "historical_signals_generated"].includes(result.status) &&
      result.resolverReady === false &&
      result.historicalFallbackUsed === true &&
      result.symbol === "TX00";

    if (!usingFixture && result.resolver?.ok !== true && !safeHistoricalSnapshot) {
      issues.push(`商品 resolver 未通過：${JSON.stringify(result.resolver)}`);
    }

    if (issues.length > 0) {
      process.stderr.write(`CAPITAL_STRATEGY_ENGINE_CHECK=FAIL issues=${issues.join(";")}\n`);
      process.exitCode = 1;
      return;
    }

    const intentText = await fs
      .readFile(path.join(tmpDir, "intents.jsonl"), "utf8")
      .catch(() => "");
    const intents = intentText
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
    for (const intent of intents) {
      if (!intent.intentRunId || typeof intent.intentRunId !== "string") {
        throw new Error(`paper intent 必須包含 intentRunId：${JSON.stringify(intent)}`);
      }
      if (
        intent.paperOnly !== true ||
        intent.allowLiveTrading !== false ||
        intent.liveTradingEnabled !== false ||
        intent.writeBrokerOrders !== false ||
        intent.writeTradingEnabled !== false ||
        intent.brokerOrderPathEnabled !== false
      ) {
        throw new Error(`paper intent 安全欄位錯誤：${JSON.stringify(intent)}`);
      }
      if (
        safeHistoricalSnapshot &&
        (intent.executionEligible !== false ||
          intent.historicalSnapshot !== true ||
          intent.promotionBlocked !== true)
      ) {
        throw new Error(
          `historical snapshot intent 必須不可執行且阻止晉升：${JSON.stringify(intent)}`,
        );
      }
    }

    const s = result.stats;
    const source = usingFixture ? " (fixture)" : " (live)";
    if (safeHistoricalSnapshot) {
      process.stdout.write(
        `CAPITAL_STRATEGY_ENGINE_CHECK=OK_SNAPSHOT resolver=${result.resolver?.status}` +
          ` symbol=${result.symbol}` +
          ` ticks=${s.totalTicks} bars=${s.barsBuilt}` +
          ` signals=${s.signalsGenerated}` +
          ` reason=${result.resolver?.reason ?? ""}` +
          `${source}\n`,
      );
      return;
    }

    process.stdout.write(
      `CAPITAL_STRATEGY_ENGINE_CHECK=OK` +
        ` ticks=${s.totalTicks} bars=${s.barsBuilt}` +
        ` signals=${s.signalsGenerated}` +
        ` orb=${s.byStrategy?.orb ?? 0}` +
        ` vwap=${s.byStrategy?.vwap ?? 0}` +
        ` ema=${s.byStrategy?.ema ?? 0}` +
        `${source}\n`,
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  process.stderr.write(`check error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});

/**
 * Discovery Prompt Builder — constructs the task prompt for the
 * strategy discovery subagent (Phase B).
 *
 * Key design: the prompt does NOT embed market data. Instead it tells
 * the subagent which tools to call (fin_kline, fin_price, fin_strategy_create)
 * so the LLM autonomously fetches data, analyzes, and creates strategies.
 */

import type { DiscoveryConfig, DiscoverySymbolSnapshot } from "./types.js";

/** Build the complete subagent task prompt (LLM drives all data fetching). */
export function buildSubagentTaskPrompt(
  config: DiscoveryConfig,
  existingStrategyNames: string[],
  /** Optional Phase A snapshots — gives the subagent a head start on regime awareness. */
  phaseASnapshots?: DiscoverySymbolSnapshot[],
): string {
  const watchlistBlock = buildWatchlistBlock(config);
  const existing =
    existingStrategyNames.length > 0
      ? existingStrategyNames.map((n) => `- ${n}`).join("\n")
      : "(无)";
  const regimeHint = phaseASnapshots?.length ? buildRegimeHint(phaseASnapshots) : "";

  return `# 策略发现任务 — 全球顶尖量化分析

## 你的角色
你是拥有 20 年经验的全球顶尖量化金融专家（Renaissance Technologies / Two Sigma 级别）。
你的任务是自主分析全球市场，设计并创建交易策略。

## 可用工具

### 数据获取
- \`fin_kline\` — 获取 K 线 (OHLCV): \`fin_kline(symbol, market?, limit?)\`
  - 示例: \`fin_kline("BTC/USDT", "crypto", 90)\` → 90 根日线
  - 示例: \`fin_kline("600519.SH", "equity", 60)\` → 60 根日线
- \`fin_price\` — 获取最新价: \`fin_price(symbol, market?)\`
- \`fin_compare\` — 多资产对比: \`fin_compare("BTC/USDT,ETH/USDT,SPY")\`

### 策略创建
- \`fin_strategy_create\` — 创建策略:
  - type: sma-crossover | rsi-mean-reversion | bollinger-bands | macd-divergence | trend-following-momentum | volatility-mean-reversion | regime-adaptive | multi-timeframe-confluence | risk-parity-triple-screen | custom
  - name: 策略名（包含标的和逻辑，如 "BTC 牛市趋势 SMA 8/21"）
  - parameters: { fastPeriod, slowPeriod, sizePct, ... }
  - symbols: ["BTC/USDT"]
  - timeframes: ["1d"]

### 策略查看
- \`fin_strategy_list\` — 查看已有策略

## 目标标的池
${watchlistBlock}

## 执行步骤

### 第一步：数据采集
对每个目标标的调用 \`fin_kline\` 获取近 90 天日线数据。
同时用 \`fin_price\` 获取最新价格。
${regimeHint}

### 第二步：深度分析
对每个标的的 K 线数据进行分析：
1. **趋势判断**: SMA50 vs SMA200 关系、价格位置
2. **动量状态**: RSI 水平、MACD 方向
3. **波动率**: 近期波幅 vs 历史波幅
4. **体制判断**: bull / bear / sideways / volatile / crisis
5. **周期位置**: 早期牛市 / 中期牛市 / 晚期牛市 / 转折期 / 早期熊市 / 深度熊市 / 震荡积累

### 第三步：策略设计
为每个有明确信号的市场设计策略，**正反方向都要有**：
- **主方向策略**（跟随当前 regime）
- **对冲策略**（防范 regime 反转，仓位较小）

参数拟合指南：
- 高波动 (ATR% > 3%) → 小仓位 (sizePct ≤ 50)、宽止损
- RSI > 60 → SMA fast period 缩短 (8-10)，更早获利
- RSI < 40 → SMA slow period 延长 (40-50)，更耐心
- 强趋势 (SMA50/200 > 1.05) → 适当加仓
- 弱趋势或横盘 → Bollinger Bands 窄 SD (1.5)

### 第四步：执行创建
对每个策略调用 \`fin_strategy_create\`，确保：
- name 包含标的 + 市场观点 + 策略逻辑
- parameters 根据数据分析调优（不要用默认值）
- 每个策略说明是做多还是做空逻辑

## 已有策略（避免重复）
${existing}

## 约束
- 本轮最多创建 ${config.maxLlmStrategies} 个策略
- 不确定的市场优先用 regime-adaptive 模板
- 先获取数据再做决策，不要凭空臆测市场状态

## 完成标准
1. 对所有目标标的获取了 K 线数据
2. 进行了深度市场分析
3. 创建了策略（调用 fin_strategy_create）
4. 输出简要总结：创建了哪些策略、市场观点、风险提示`;
}

/** Build the wake message for the main agent (instructs it to spawn subagent). */
export function buildWakeMessage(
  symbolCount: number,
  deterministicCount: number,
  subagentTask: string,
): string {
  return (
    `[findoo-trader] Strategy Discovery 完成市场扫描: ${symbolCount} 个标的, ` +
    `已创建 ${deterministicCount} 个确定性策略。\n\n` +
    `请使用 sessions_spawn 创建策略发现子 Agent 进行深度分析:\n` +
    `- runtime: "subagent"\n` +
    `- mode: "run"\n` +
    `- sandbox: "inherit"\n` +
    `- label: "策略发现"\n` +
    `- task: 以下内容\n\n` +
    subagentTask
  );
}

/** Format the watchlist as a readable block. */
function buildWatchlistBlock(config: DiscoveryConfig): string {
  const lines: string[] = [];
  if (config.watchlist.crypto.length > 0) {
    lines.push(`**Crypto**: ${config.watchlist.crypto.join(", ")}`);
  }
  if (config.watchlist.equity.length > 0) {
    lines.push(`**US Equity**: ${config.watchlist.equity.join(", ")}`);
  }
  if (config.watchlist.hkStock.length > 0) {
    lines.push(`**HK Stock**: ${config.watchlist.hkStock.join(", ")}`);
  }
  if (config.watchlist.aShare.length > 0) {
    lines.push(`**A-Share**: ${config.watchlist.aShare.join(", ")}`);
  }
  return lines.join("\n");
}

/** Optional regime hint from Phase A — helps subagent skip redundant analysis. */
function buildRegimeHint(snapshots: DiscoverySymbolSnapshot[]): string {
  if (snapshots.length === 0) return "";
  const hints = snapshots.map(
    (s) =>
      `  - ${s.symbol}: regime=${s.regime}, RSI=${s.rsi14.toFixed(0)}, ATR%=${s.atrPct.toFixed(1)}`,
  );
  return `\n**Phase A 预扫描提示**（仅供参考，以你获取的实时数据为准）：\n${hints.join("\n")}`;
}

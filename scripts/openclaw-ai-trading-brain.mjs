/**
 * openclaw-ai-trading-brain.mjs — AI 交易大腦
 * 整合 6 大 AI 功能模組，讓自動交易系統超級強大
 *
 * 模組:
 *   1. LLM 新聞情緒分析 (Ollama local / Claude API)
 *   2. ML Regime 偵測 (統計學習)
 *   3. 異常偵測 (Isolation Forest 概念)
 *   4. 強化學習參數優化 (Bayesian Optimization)
 *   5. 多 Agent 辯論決策 (DMAD pattern)
 *   6. 資金曲線 Meta-Strategy (動態配置最優策略)
 *
 * 所有模組 read-only safe，不直接下單
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);

// ============================================================
// MODULE 1: LLM 新聞情緒分析
// ============================================================
export class LlmSentimentAnalyzer {
  constructor(opts = {}) {
    // 支援 Ollama (本地免費) 或 Claude API
    this.provider = opts.provider || "ollama"; // "ollama" | "claude" | "mock"
    this.ollamaUrl = opts.ollamaUrl || "http://localhost:11434/api/generate";
    this.model = opts.model || "llama3.1:8b"; // 本地 Ollama 模型
    this.claudeApiKey = opts.claudeApiKey || process.env.ANTHROPIC_API_KEY;
  }

  async analyze(headlines) {
    if (!Array.isArray(headlines) || headlines.length === 0) {
      return { sentiment: 0, confidence: 0, signals: [] };
    }

    const prompt = `You are a financial sentiment analyzer. Analyze these headlines and return ONLY a JSON object:
{"sentiment": <-1.0 to 1.0>, "confidence": <0 to 1.0>, "signals": [{"headline": "...", "score": <-1 to 1>, "impact": "high|medium|low"}]}

Headlines:
${headlines.map((h, i) => `${i + 1}. ${h}`).join("\n")}

Return ONLY valid JSON, no explanation.`;

    try {
      if (this.provider === "ollama") {
        return await this._callOllama(prompt);
      }
      if (this.provider === "claude") {
        return await this._callClaude(prompt);
      }
      return this._mockSentiment(headlines);
    } catch (e) {
      return { sentiment: 0, confidence: 0, error: e.message, signals: [] };
    }
  }

  async _callOllama(prompt) {
    const resp = await fetch(this.ollamaUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt, stream: false, format: "json" }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await resp.json();
    try {
      return JSON.parse(data.response);
    } catch {
      return { sentiment: 0, confidence: 0, raw: data.response };
    }
  }

  async _callClaude(prompt) {
    if (!this.claudeApiKey) {
      return { sentiment: 0, confidence: 0, error: "no_api_key" };
    }
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.claudeApiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 500,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await resp.json();
    const text = data.content?.[0]?.text || "";
    try {
      return JSON.parse(text);
    } catch {
      return { sentiment: 0, confidence: 0, raw: text };
    }
  }

  _mockSentiment(headlines) {
    // 基於關鍵字的快速情緒分析（不需要 LLM）
    const bullWords = [
      "rally",
      "surge",
      "bull",
      "up",
      "gain",
      "rise",
      "record",
      "buy",
      "positive",
      "漲",
      "多",
      "突破",
      "創高",
    ];
    const bearWords = [
      "crash",
      "drop",
      "bear",
      "down",
      "loss",
      "fall",
      "fear",
      "sell",
      "negative",
      "跌",
      "空",
      "崩",
      "恐慌",
    ];
    let totalScore = 0;
    const signals = headlines.map((h) => {
      const lower = h.toLowerCase();
      const bulls = bullWords.filter((w) => lower.includes(w)).length;
      const bears = bearWords.filter((w) => lower.includes(w)).length;
      const score = Math.max(-1, Math.min(1, (bulls - bears) * 0.3));
      totalScore += score;
      return { headline: h.slice(0, 60), score, impact: Math.abs(score) > 0.5 ? "high" : "medium" };
    });
    return {
      sentiment: totalScore / headlines.length,
      confidence: 0.4,
      signals,
      provider: "keyword_mock",
    };
  }
}

// ============================================================
// MODULE 2: ML Regime 偵測
// ============================================================
export class RegimeDetector {
  constructor() {
    this.history = []; // 最近 N 天的 regime 紀錄
  }

  /**
   * 基於價格序列偵測市場 regime
   * @param {Array<{close, high, low, volume}>} bars - OHLCV bars
   * @returns {{ regime, volatility, trend, momentum, confidence }}
   */
  detect(bars) {
    if (!bars || bars.length < 20) {
      return { regime: "unknown", confidence: 0 };
    }

    const closes = bars.map((b) => b.close);
    const returns = [];
    for (let i = 1; i < closes.length; i++) {
      returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    }

    // 波動率 (annualized)
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
    const volatility = Math.sqrt(variance) * Math.sqrt(252) * 100; // annualized %

    // 趨勢強度 (ADX-like via directional movement)
    const sma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const sma50 = closes.length >= 50 ? closes.slice(-50).reduce((a, b) => a + b, 0) / 50 : sma20;
    const trendStrength = Math.abs(sma20 - sma50) / sma50;

    // 動量 (RSI-like)
    const gains = returns.filter((r) => r > 0);
    const losses = returns.filter((r) => r < 0);
    const avgGain = gains.length ? gains.reduce((a, b) => a + b, 0) / returns.length : 0;
    const avgLoss = losses.length
      ? Math.abs(losses.reduce((a, b) => a + b, 0)) / returns.length
      : 0.001;
    const rsi = 100 - 100 / (1 + avgGain / avgLoss);
    const momentum = (rsi - 50) / 50; // -1 to 1

    // Regime 分類
    let regime;
    if (volatility > 30 && trendStrength > 0.02) {
      regime = "crisis_trend"; // 危機趨勢
    } else if (volatility > 25 && trendStrength < 0.01) {
      regime = "high_vol_chop"; // 高波震盪
    } else if (volatility > 20 && momentum > 0.3) {
      regime = "volatile_bull"; // 波動牛市
    } else if (volatility > 20 && momentum < -0.3) {
      regime = "volatile_bear"; // 波動熊市
    } else if (volatility < 12 && trendStrength > 0.015) {
      regime = "quiet_trend"; // 安靜趨勢
    } else if (volatility < 12) {
      regime = "low_vol_range"; // 低波區間
    } else if (momentum > 0.4) {
      regime = "strong_bull"; // 強勢多頭
    } else if (momentum < -0.4) {
      regime = "strong_bear"; // 強勢空頭
    } else {
      regime = "neutral"; // 中性
    }

    // 策略建議
    const strategyHints = {
      crisis_trend: ["TurtleStrategy", "SupertrendStrategy"],
      high_vol_chop: ["MeanReversionHftStrategy", "GridTradingStrategy"],
      volatile_bull: ["BreakoutStrategy", "TickMomentumStrategy"],
      volatile_bear: ["PsarStrategy", "StopLossManager"],
      quiet_trend: ["MaCrossStrategy", "IchimokuStrategy"],
      low_vol_range: ["BollingerBandStrategy", "RsiStrategy"],
      strong_bull: ["BreakoutStrategy", "OpeningRangeBreakoutStrategy"],
      strong_bear: ["DivergenceStrategy", "PivotReversalStrategy"],
      neutral: ["DcaDipperStrategy", "VwapStrategy"],
    };

    return {
      regime,
      volatility: +volatility.toFixed(2),
      trendStrength: +trendStrength.toFixed(4),
      momentum: +momentum.toFixed(3),
      rsi: +rsi.toFixed(1),
      confidence: volatility > 5 ? 0.8 : 0.5,
      recommendedStrategies: strategyHints[regime] || [],
      timestamp: new Date().toISOString(),
    };
  }
}

// ============================================================
// MODULE 3: 異常偵測
// ============================================================
export class AnomalyDetector {
  constructor(opts = {}) {
    this.windowSize = opts.windowSize || 50;
    this.zThreshold = opts.zThreshold || 3.0; // 3 sigma
  }

  /**
   * 偵測價格/成交量異常
   * @param {Array<{close, volume, time}>} bars
   * @returns {Array<{type, severity, time, details}>}
   */
  detect(bars) {
    if (bars.length < this.windowSize) {
      return [];
    }
    const anomalies = [];

    // 價格跳空偵測
    for (let i = 1; i < bars.length; i++) {
      const ret = Math.abs((bars[i].close - bars[i - 1].close) / bars[i - 1].close);
      const window = bars.slice(Math.max(0, i - this.windowSize), i);
      const rets = window
        .map((b, j) =>
          j > 0 ? Math.abs((b.close - window[j - 1].close) / window[j - 1].close) : 0,
        )
        .filter((r) => r > 0);
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const std = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length) || 0.001;
      const z = (ret - mean) / std;

      if (z > this.zThreshold) {
        anomalies.push({
          type: "price_spike",
          severity: z > 5 ? "critical" : "warning",
          time: bars[i].time,
          zScore: +z.toFixed(2),
          details: `Price moved ${(ret * 100).toFixed(2)}% (${z.toFixed(1)} sigma)`,
        });
      }
    }

    // 成交量異常
    const volumes = bars.map((b) => b.volume || 0).filter((v) => v > 0);
    if (volumes.length > 10) {
      const vMean = volumes.reduce((a, b) => a + b, 0) / volumes.length;
      const vStd =
        Math.sqrt(volumes.reduce((a, b) => a + (b - vMean) ** 2, 0) / volumes.length) || 1;
      for (let i = bars.length - 5; i < bars.length; i++) {
        const vz = ((bars[i].volume || 0) - vMean) / vStd;
        if (vz > this.zThreshold) {
          anomalies.push({
            type: "volume_spike",
            severity: "warning",
            time: bars[i].time,
            zScore: +vz.toFixed(2),
            details: `Volume ${bars[i].volume} is ${vz.toFixed(1)} sigma above mean`,
          });
        }
      }
    }

    return anomalies;
  }
}

// ============================================================
// MODULE 4: Bayesian 參數優化器
// ============================================================
export class BayesianParamOptimizer {
  constructor(opts = {}) {
    this.maxIter = opts.maxIter || 50;
    this.history = []; // { params, score }
  }

  /**
   * 對策略參數做 Bayesian 風格探索
   * @param {Object} paramRanges - { paramName: [min, max] }
   * @param {Function} objectiveFn - async (params) => score (higher = better)
   */
  async optimize(paramRanges, objectiveFn) {
    const paramNames = Object.keys(paramRanges);
    let bestParams = null,
      bestScore = -Infinity;

    for (let i = 0; i < this.maxIter; i++) {
      // 前 30% 隨機探索，後 70% 在最佳周圍小幅擾動
      const params = {};
      for (const name of paramNames) {
        const [min, max] = paramRanges[name];
        if (i < this.maxIter * 0.3 || !bestParams) {
          params[name] = min + Math.random() * (max - min);
        } else {
          const range = max - min;
          const noise = (Math.random() - 0.5) * range * 0.2; // ±10% of range
          params[name] = Math.max(min, Math.min(max, bestParams[name] + noise));
        }
      }

      try {
        const score = await objectiveFn(params);
        this.history.push({ iter: i, params: { ...params }, score });
        if (score > bestScore) {
          bestScore = score;
          bestParams = { ...params };
        }
      } catch {
        /* skip failed eval */
      }
    }

    return {
      bestParams,
      bestScore,
      iterations: this.history.length,
      convergence: this.history.map((h) => h.score),
    };
  }
}

// ============================================================
// MODULE 5: 多 Agent 辯論決策 (DMAD)
// ============================================================
export class MultiAgentDebate {
  constructor(opts = {}) {
    this.agents = opts.agents || [
      { id: "bull_agent", bias: "bullish", weight: 1.0 },
      { id: "bear_agent", bias: "bearish", weight: 1.0 },
      { id: "quant_agent", bias: "neutral", weight: 1.5 }, // 量化 agent 加權
    ];
  }

  /**
   * 三方辯論產生交易決策
   * @param {Object} context - { regime, sentiment, anomalies, technicals }
   * @returns {{ decision, confidence, reasoning[] }}
   */
  debate(context) {
    const votes = [];

    for (const agent of this.agents) {
      const vote = this._agentVote(agent, context);
      votes.push({ ...agent, ...vote });
    }

    // 加權投票
    let weightedSum = 0,
      totalWeight = 0;
    for (const v of votes) {
      weightedSum += v.signal * v.weight * v.confidence;
      totalWeight += v.weight;
    }
    const consensus = weightedSum / totalWeight;

    let decision;
    if (consensus > 0.3) {
      decision = "buy";
    } else if (consensus < -0.3) {
      decision = "sell";
    } else {
      decision = "hold";
    }

    // 一致性 = 所有 agent 同方向
    const allAgree = votes.every((v) => Math.sign(v.signal) === Math.sign(consensus));

    return {
      decision,
      signal: +consensus.toFixed(3),
      confidence: allAgree ? 0.9 : Math.abs(consensus) > 0.5 ? 0.7 : 0.4,
      unanimous: allAgree,
      votes,
      timestamp: new Date().toISOString(),
    };
  }

  _agentVote(agent, ctx) {
    // 簡化的 agent 投票邏輯 (實際可接 LLM)
    let signal = 0,
      confidence = 0.5;
    const reasons = [];

    if (agent.bias === "bullish") {
      if (ctx.sentiment > 0.2) {
        signal += 0.4;
        reasons.push("positive_sentiment");
      }
      if (ctx.regime?.includes("bull")) {
        signal += 0.3;
        reasons.push("bull_regime");
      }
      if (ctx.momentum > 0.3) {
        signal += 0.3;
        reasons.push("strong_momentum");
      }
      signal = Math.min(1, signal);
      confidence = 0.6;
    } else if (agent.bias === "bearish") {
      if (ctx.sentiment < -0.2) {
        signal -= 0.4;
        reasons.push("negative_sentiment");
      }
      if (ctx.regime?.includes("bear") || ctx.regime?.includes("crisis")) {
        signal -= 0.3;
        reasons.push("bear_regime");
      }
      if (ctx.anomalies?.length > 0) {
        signal -= 0.3;
        reasons.push("anomaly_detected");
      }
      signal = Math.max(-1, signal);
      confidence = 0.6;
    } else {
      // quant
      signal = (ctx.momentum || 0) * 0.5 + (ctx.sentiment || 0) * 0.3;
      if (ctx.regime === "high_vol_chop") {
        signal *= 0.3;
        reasons.push("reduce_in_chop");
      }
      if (ctx.anomalies?.length > 2) {
        signal = 0;
        reasons.push("too_many_anomalies");
      }
      confidence = 0.75;
      reasons.push("quant_model");
    }

    return { signal: +signal.toFixed(3), confidence, reasons };
  }
}

// ============================================================
// MODULE 6: Meta-Strategy 資金曲線配置
// ============================================================
export class MetaStrategyAllocator {
  /**
   * 根據各策略近期表現動態分配資金比重
   * @param {Array<{id, sharpe, maxDD, winRate, trades}>} strategies
   * @returns {Array<{id, weight, reason}>}
   */
  allocate(strategies) {
    if (!strategies.length) {
      return [];
    }

    // 計算綜合分數 (Sharpe * 0.4 + WinRate * 0.3 + (1 - MaxDD/100) * 0.3)
    const scored = strategies
      .map((s) => ({
        ...s,
        score: (s.sharpe || 0) * 0.4 + (s.winRate || 0) * 0.3 + (1 - (s.maxDD || 50) / 100) * 0.3,
      }))
      .filter((s) => s.score > 0 && s.trades >= 20);

    if (!scored.length) {
      return strategies.map((s) => ({ id: s.id, weight: 0, reason: "insufficient_data" }));
    }

    const totalScore = scored.reduce((a, b) => a + b.score, 0);
    return scored
      .map((s) => ({
        id: s.id,
        weight: +(s.score / totalScore).toFixed(3),
        score: +s.score.toFixed(3),
        reason: s.sharpe > 1.5 ? "high_sharpe" : s.winRate > 0.6 ? "high_winrate" : "balanced",
      }))
      .toSorted((a, b) => b.weight - a.weight);
  }
}

// ============================================================
// 整合: AI Trading Brain
// ============================================================
export class AiTradingBrain {
  constructor(opts = {}) {
    this.sentiment = new LlmSentimentAnalyzer(opts.sentiment || { provider: "mock" });
    this.regime = new RegimeDetector();
    this.anomaly = new AnomalyDetector();
    this.optimizer = new BayesianParamOptimizer();
    this.debate = new MultiAgentDebate();
    this.metaAlloc = new MetaStrategyAllocator();
  }

  /**
   * 完整 AI 分析循環
   * @param {Object} input - { bars, headlines, strategies }
   * @returns {Promise<Object>} AI 綜合分析報告
   */
  async analyze(input) {
    const { bars = [], headlines = [], strategies = [] } = input;
    const now = new Date();

    // 並行執行所有 AI 模組
    const [sentimentResult, regimeResult, anomalies] = await Promise.all([
      this.sentiment.analyze(headlines),
      Promise.resolve(this.regime.detect(bars)),
      Promise.resolve(this.anomaly.detect(bars)),
    ]);

    // DMAD 辯論
    const debateResult = this.debate.debate({
      sentiment: sentimentResult.sentiment,
      regime: regimeResult.regime,
      momentum: regimeResult.momentum,
      anomalies,
    });

    // Meta-Strategy 配置
    const allocation = this.metaAlloc.allocate(strategies);

    const report = {
      schema: "openclaw.ai-trading-brain.v1",
      generatedAt: now.toISOString(),
      sentiment: sentimentResult,
      regime: regimeResult,
      anomalies: {
        count: anomalies.length,
        critical: anomalies.filter((a) => a.severity === "critical").length,
        items: anomalies.slice(0, 5),
      },
      debate: debateResult,
      allocation: allocation.slice(0, 10),
      decision: {
        action: debateResult.decision,
        confidence: debateResult.confidence,
        regime: regimeResult.regime,
        sentiment: sentimentResult.sentiment,
        anomalyAlert: anomalies.some((a) => a.severity === "critical"),
      },
      safety: { readOnlyAnalysis: true, allowLiveTrading: false, sentOrder: false },
    };

    return report;
  }
}

// === CLI ===
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const brain = new AiTradingBrain({ sentiment: { provider: "mock" } });

  // Demo data
  const bars = Array.from({ length: 60 }, (_, i) => ({
    close: 20000 + Math.sin(i / 10) * 500 + Math.random() * 200,
    high: 20100 + Math.sin(i / 10) * 500,
    low: 19900 + Math.sin(i / 10) * 500,
    volume: 5000 + Math.random() * 3000,
    time: new Date(Date.now() - (60 - i) * 60000).toISOString(),
  }));

  const headlines = [
    "台股加權指數突破兩萬三千點創歷史新高",
    "Fed維持利率不變 市場預期年底前降息",
    "AI概念股持續領漲 台積電再創天價",
    "中東局勢緊張 油價飆升至新高",
  ];

  const strategies = [
    { id: "RSI", sharpe: 1.8, maxDD: 6, winRate: 0.58, trades: 150 },
    { id: "MACD", sharpe: 1.2, maxDD: 10, winRate: 0.52, trades: 200 },
    { id: "Breakout", sharpe: 0.9, maxDD: 15, winRate: 0.45, trades: 80 },
  ];

  const report = await brain.analyze({ bars, headlines, strategies });

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`=== AI Trading Brain ===`);
    console.log(
      `Regime: ${report.regime.regime} (vol=${report.regime.volatility}%, mom=${report.regime.momentum})`,
    );
    console.log(
      `Sentiment: ${report.sentiment.sentiment?.toFixed(2)} (${report.sentiment.provider || "llm"})`,
    );
    console.log(`Anomalies: ${report.anomalies.count} (${report.anomalies.critical} critical)`);
    console.log(
      `DMAD Decision: ${report.debate.decision} (signal=${report.debate.signal}, conf=${report.debate.confidence})`,
    );
    console.log(`  Unanimous: ${report.debate.unanimous}`);
    console.log(`Allocation:`);
    report.allocation.forEach((a) =>
      console.log(`  ${a.id}: ${(a.weight * 100).toFixed(1)}% (${a.reason})`),
    );
    console.log(
      `\nFinal: ${report.decision.action.toUpperCase()} confidence=${report.decision.confidence}`,
    );
  }
}

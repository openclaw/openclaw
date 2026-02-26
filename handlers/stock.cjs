// Taiwan Stock + Financial Analysis Handler
// Priority 1.4 (stock) + 1.5 (financial)
// Stock symbols route to real-time data; financial queries add context for LLM

module.exports = {
  name: "stock",
  priority: 1.4,

  /**
   * @param {Object} deps - { detectStockSymbol, fetchTaiwanStockIndicators, detectFinancialIntent }
   */
  init(deps) {
    this._deps = deps;
  },

  match(ctx) {
    const { detectStockSymbol, detectFinancialIntent } = this._deps;

    const symbol = detectStockSymbol(ctx.userText);
    if (symbol) {
      return { matched: true, stockSymbol: symbol, type: "stock" };
    }

    const financial = detectFinancialIntent(ctx.userText);
    if (financial) {
      return { matched: true, financialIntent: financial, type: "financial" };
    }

    return false;
  },

  async execute(ctx) {
    if (ctx.type === "stock") {
      return this._handleStock(ctx);
    }
    if (ctx.type === "financial") {
      return this._handleFinancial(ctx);
    }
    return { status: "pass" };
  },

  async _handleStock(ctx) {
    const { fetchTaiwanStockIndicators } = this._deps;
    const stockAbort = new AbortController();

    try {
      const indicators = await fetchTaiwanStockIndicators(ctx.stockSymbol, stockAbort.signal);
      if (!indicators || !indicators.latest_close) {
        throw new Error(`${ctx.stockSymbol} 暫無數據`);
      }

      let analysis = `【${indicators.stock_name}（${indicators.stock_id}）技術分析】\n`;
      analysis += `📊 最新收盤: ${indicators.latest_close.toFixed(2)} 元\n`;
      analysis += `📈 指標: MA5=${(indicators.ma_5 || 0).toFixed(2)}, MA20=${(indicators.ma_20 || 0).toFixed(2)}, RSI=${(indicators.rsi_14 || 0).toFixed(2)}, MACD=${(indicators.macd || 0).toFixed(2)}\n`;
      analysis += `📊 趨勢: ${indicators.trend_signal || "N/A"}\n`;
      if (indicators.rsi_14 && indicators.rsi_14 > 70) {
        analysis += `⚠️ RSI>70 超買\n`;
      } else if (indicators.rsi_14 && indicators.rsi_14 < 30) {
        analysis += `🔥 RSI<30 超賣\n`;
      }
      analysis += `\n⚠️ 免責聲明: 本分析僅供參考，非投資建議。`;

      return {
        status: "handled",
        body: `[台股分析]\n${analysis}`,
        executor: "claude",
        tracePatch: {
          route_path: "stock_direct",
          spans: [{ stage: "taiwan_stock", symbol: ctx.stockSymbol, success: true }],
        },
      };
    } catch (e) {
      // Stock error → provide context for LLM fallback (return as skillContext)
      return {
        status: "pass",
        skillContext: `[台股資訊] 用戶查詢股票 ${ctx.stockSymbol}，但即時數據暫時不可用。請根據你的知識提供分析，並提醒用戶數據可能不是最新的。`,
        tracePatch: {
          spans: [{ stage: "taiwan_stock", symbol: ctx.stockSymbol, error: e.message }],
        },
      };
    }
  },

  _handleFinancial(ctx) {
    return {
      status: "pass",
      skillContext: `[金融分析模式] 用戶查詢: ${ctx.userText}\n請以台股投資顧問角色分析。免責聲明: 本意見僅供參考，非投資建議。`,
    };
  },
};

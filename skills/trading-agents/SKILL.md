---
name: trading-agents
description: "Run TradingAgents multi-agent LLM trading analysis via CLI or Python. Use when: (1) analyzing a stock ticker with fundamental, sentiment, technical, and news analysis, (2) getting AI-powered buy/hold/sell decisions with risk assessment, (3) backtesting trading strategies over date ranges. NOT for: real-time order execution, portfolio management with live brokers, or non-equity asset classes. Requires: Python 3.11+, tradingagents package."
metadata:
  {
    "openclaw":
      {
        "emoji": "📈",
        "requires": { "bins": ["python3"] },
        "install":
          [
            {
              "id": "uv",
              "kind": "uv",
              "package": "tradingagents",
              "bins": ["tradingagents"],
              "label": "Install TradingAgents (uv pip)",
            },
          ],
      },
  }
---

# TradingAgents - Multi-Agent LLM Financial Trading Framework

> From [TauricResearch/TradingAgents](https://github.com/TauricResearch/TradingAgents) (35k+ stars)

## When to Use

- Analyzing a stock ticker with fundamental, sentiment, technical, and news analysis
- Getting AI-powered buy/hold/sell decisions with risk assessment
- Backtesting trading strategies over date ranges

## When NOT to Use

- Real-time order execution or live broker integration
- Portfolio management with live brokers
- Analyzing non-equity asset classes

TradingAgents deploys specialized LLM-powered agents (fundamental analyst, sentiment analyst, technical analyst, news analyst, bull/bear researchers, trader, risk manager, portfolio manager) that collaboratively evaluate market conditions and produce trading decisions.

## Setup

```bash
pip install tradingagents
```

Set at least one LLM provider key:

```bash
export OPENAI_API_KEY=...          # OpenAI (GPT)
export GOOGLE_API_KEY=...          # Google (Gemini)
export ANTHROPIC_API_KEY=...       # Anthropic (Claude)
export XAI_API_KEY=...             # xAI (Grok)
export OPENROUTER_API_KEY=...      # OpenRouter (any model)
```

No extra data API keys needed — defaults to yfinance for market data.

## Quick Analysis (Python one-liner)

```bash
python3 -c "
from tradingagents.graph.trading_graph import TradingAgentsGraph
from tradingagents.default_config import DEFAULT_CONFIG
config = DEFAULT_CONFIG.copy()
config['llm_provider'] = 'anthropic'
config['deep_think_llm'] = 'claude-sonnet-4-20250514'
config['quick_think_llm'] = 'claude-sonnet-4-20250514'
ta = TradingAgentsGraph(debug=True, config=config)
_, decision = ta.propagate('NVDA', '2024-05-10')
print(decision)
"
```

## CLI Usage

After installing via pip:

```bash
tradingagents
```

Or if installed from source:

```bash
cd /path/to/TradingAgents
python -m cli.main
```

The CLI provides an interactive interface to select tickers, dates, LLM providers, and research depth.

## Python Package Usage

```python
from tradingagents.graph.trading_graph import TradingAgentsGraph
from tradingagents.default_config import DEFAULT_CONFIG

# Configure
config = DEFAULT_CONFIG.copy()
config["llm_provider"] = "openai"           # or "anthropic", "google", "xai", "ollama"
config["deep_think_llm"] = "gpt-5"           # strong reasoning model (e.g. gpt-5, o3)
config["quick_think_llm"] = "gpt-5-mini"    # fast model for quick tasks
config["max_debate_rounds"] = 1             # bull vs bear debate rounds
config["max_risk_discuss_rounds"] = 1       # risk team discussion rounds

# Data vendors (all default to yfinance, no extra API needed)
config["data_vendors"] = {
    "core_stock_apis": "yfinance",
    "technical_indicators": "yfinance",
    "fundamental_data": "yfinance",
    "news_data": "yfinance",
}

# Initialize and run
ta = TradingAgentsGraph(debug=True, config=config)
state, decision = ta.propagate("AAPL", "2024-11-15")
print(decision)

# After observing actual returns, teach the system
# ta.reflect_and_remember(position_returns)
```

## Agent Architecture

The framework mirrors a real trading firm:

1. **Analyst Team** - 4 specialized analysts run in parallel:
   - Fundamentals Analyst: company financials, intrinsic value
   - Sentiment Analyst: social media sentiment scoring
   - News Analyst: macro events, global news impact
   - Technical Analyst: MACD, RSI, chart patterns

2. **Researcher Team** - Bull vs Bear debate:
   - Bullish researcher argues for the trade
   - Bearish researcher argues against
   - Structured debate produces balanced assessment

3. **Trader Agent** - Synthesizes all reports into a trade proposal

4. **Risk Management** - Evaluates volatility, liquidity, portfolio risk

5. **Portfolio Manager** - Final approve/reject decision

## Supported LLM Providers

| Provider | Config Value | Models |
|----------|-------------|--------|
| OpenAI | `"openai"` | gpt-5.2, gpt-5-mini, etc. |
| Anthropic | `"anthropic"` | claude-sonnet-4-20250514, etc. |
| Google | `"google"` | gemini-3.1-pro, etc. |
| xAI | `"xai"` | grok-4, etc. |
| Ollama | `"ollama"` | Any local model |
| OpenRouter | `"openrouter"` | Any OpenRouter model |

## Tips

- Use `debug=True` to see each agent's reasoning in real-time
- Start with `max_debate_rounds=1` for faster results, increase for deeper analysis
- yfinance is free but rate-limited; use alpha_vantage for production workloads
- The `reflect_and_remember()` method teaches the system from actual trade outcomes
- Results are cached in `./results/` directory for review

## Links

- [GitHub](https://github.com/TauricResearch/TradingAgents)
- [Paper](https://arxiv.org/abs/2412.20138)
- [Discord](https://discord.com/invite/hk9PGKShPK)

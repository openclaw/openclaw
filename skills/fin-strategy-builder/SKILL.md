---
name: fin-strategy-builder
description: "Strategy builder — turn natural language trading ideas into compliant FEP skill packages with auto-generated code, validation, and L1/L2 routing."
metadata:
  {
    "openclaw":
      {
        "emoji": "🏗️",
        "requires":
          {
            "extensions":
              [
                "fin-core",
                "fin-market-data",
                "fin-data-bus",
                "fin-strategy-engine",
              ],
          },
      },
  }
---

# Strategy Builder

Turn natural language trading ideas into compliant FEP skill packages. Generates complete `fep.yaml` + `scripts/` (+ optional `skill.md`), validates against the FEP 1.0 spec, and determines whether the strategy should run as L1 (script) or L2 (agent).

## When to Use

**USE this skill when:**

- "help me create a strategy" / "build a strategy"
- "I want to DCA into BTC every week, buy more when it dips"
- "make me a trend following strategy for ETH"
- "generate a FEP skill package"
- "I have a trading idea but don't know how to code it"
- "create a strategy for sideways crypto markets"
- "turn this idea into a backtest-ready package"
- "build a grid trading strategy for SOL"

## When NOT to Use

**DON'T use this skill when:**

- User wants to backtest an existing strategy -- use fin-backtest
- User wants to evolve/mutate an existing strategy -- use fin-strategy-evolution
- User wants research on which strategy type fits current market -- use fin-strategy-research
- User wants to execute a live trade -- use fin-trading
- User wants portfolio analysis -- use fin-portfolio

## Tools

### Intent & Data Validation

- `fin_data_ohlcv` -- Verify data availability for requested symbols
- `fin_data_regime` -- Analyze current market regime (informs strategy design)
- `fin_market_price` -- Check current prices and validate symbol existence

### Code Generation & Validation

- `fin_backtest_run` -- Sanity check: quick backtest on 3-month data to verify generated code runs correctly
- `fin_strategy_create` -- Register the generated strategy in the platform

### Supporting

- `fin_paper_create` -- Deploy validated strategy to paper trading (optional follow-up)

## Builder Pipeline

### Step 1: Intent Collection (Conversational)

Extract key dimensions through natural dialogue:

| Dimension | Question | Example |
|-----------|----------|---------|
| Asset | "What do you want to trade?" | BTC, ETH, AAPL, 沪深300 |
| Frequency | "How often?" | daily, weekly, monthly |
| Core idea | "What's the basic approach?" | buy dips, trend follow, grid |
| Capital | "Starting capital?" | $10,000 |
| Risk tolerance | "Max acceptable loss?" | 25% drawdown |
| Time horizon | "Backtest period?" | 2023-01 to now |
| Market | "Which exchange/market?" | Binance, US stock, A-share |

If the user provides a vague idea like "buy BTC when it's cheap", ask clarifying questions to pin down the mechanism (RSI oversold? below moving average? fixed schedule?).

### Step 2: Technical Design (Propose & Confirm)

Based on collected intent, propose a concrete technical design:

1. **Strategy archetype**: Map idea to closest type (DCA, trend, mean-reversion, momentum, grid, arbitrage)
2. **Indicators**: Select appropriate technical indicators (RSI, EMA, MACD, Bollinger, ATR, etc.)
3. **Entry/exit logic**: Define signal generation rules
4. **Position sizing**: Fixed, adaptive, or regime-based
5. **Risk controls**: Stop-loss, max drawdown, position limits
6. **Market adaptations**: Fee model, settlement rules (T+1 for A-shares), lot sizes

Present the design clearly and **wait for user confirmation** before generating code. Example:

```
📊 Technical Design:
- Type: Adaptive DCA with RSI Regime Detection
- Indicators: RSI(14) + 30-day volatility
- 5 regimes: extreme_fear → extreme_greed
- Multipliers: fear=2x, neutral=1x, greed=0.5x
- Risk: 25% max drawdown, $500 single trade cap
- Data: BTC-USD daily, Binance, 365-day lookback

Does this look right? Any adjustments?
```

### Step 3: Code Generation

Generate the complete FEP skill package:

```
{strategy-id}/{version}/
├── fep.yaml              # 10 Sections (A-J)
├── scripts/
│   ├── requirements.txt  # Python dependencies
│   ├── strategy.py       # Entry: execute() + record_trade()
│   ├── indicators.py     # Technical indicators
│   └── risk_manager.py   # Risk: check_trade() + tick()
├── readme.md             # User documentation
└── [skill.md]            # Only if L2 agent routing
```

**Code contracts that MUST be followed:**

```python
# strategy.py — mandatory interface
class XxxStrategy:
    def __init__(self, config: StrategyConfig): ...
    def execute(self, market_data: pd.DataFrame, symbol: str) -> TradeDecision: ...
    def record_trade(self, symbol: str, amount: float, price: float): ...

# risk_manager.py — mandatory interface
class RiskManager:
    def check_trade(self, amount, portfolio_value, capital, positions) -> dict: ...
    def update_portfolio_value(self, value: float): ...
    def tick(self): ...

# market_data DataFrame columns (OHLCV contract):
# date, open, high, low, close, volume
```

**fep.yaml critical sections:**

- Section A (Identity): auto-generate ID from archetype + asset
- Section B (Classification): archetype, assetClasses, markets, frequency
- Section C (Parameters): user-tunable params with min/max/default ranges
- Section D (Technical): dataRequirements MUST match actual code usage
- Section E (Backtest): defaultPeriod, initialCapital, fees, slippage
- Section F (Risk): maxDrawdown, stopLoss, maxLeverage from user intent

### Step 4: Self-Validation

Run the generated package through validation checks:

1. **Structure check**: All required files exist, fep.yaml parseable
2. **Interface check**: strategy.py has execute() and record_trade() with correct signatures
3. **Data consistency**: fep.yaml dataRequirements matches symbols/frequency used in code
4. **Safety check**: No dangerous imports (os, subprocess, socket, eval, exec)
5. **Sanity backtest**: Run `fin_backtest_run` on 3-month subset to verify code executes without errors

If any check fails, **auto-fix and re-validate** (up to 3 iterations). If still failing after 3 attempts, present the issue to the user with a clear explanation.

### Step 5: L1/L2 Routing Decision

Determine whether the strategy needs agent augmentation:

| Signal | L1 (Script) | L2 (Agent) |
|--------|------------|------------|
| Decision logic | Fully deterministic rules | Requires judgment, context |
| Indicators | Fixed set, computed mechanically | Dynamic selection, multi-timeframe |
| Position sizing | Formula-based | Adaptive based on market analysis |
| Data needs | OHLCV only | Additional analysis (volume profile, correlations) |
| User request | "just run the rules" | "I want AI to analyze and decide" |

**Default: L1** (cheaper, deterministic, faster). Only generate `skill.md` if:
- User explicitly wants agent involvement
- Strategy complexity genuinely benefits from LLM analysis
- Multi-factor strategies where factor weighting is judgment-based

### Step 6: Delivery

Present the completed package:

```
✅ Strategy package generated and validated!

📦 fin-dca-adaptive/1.0.0/
   ├── fep.yaml           (10 sections, 180 lines)
   ├── scripts/strategy.py (DCAAdaptiveStrategy)
   ├── scripts/indicators.py (RSI, volatility, regime)
   ├── scripts/risk_manager.py (25% drawdown guard)
   └── readme.md

🔀 Routing: L1 Script Engine (deterministic, $0)

Next steps:
1. Run backtest → "backtest this strategy" (fin-backtest)
2. Deploy to paper → "paper trade this" (fin-paper-trading)
3. Tweak parameters → edit fep.yaml parameters section
4. Upgrade to L2 → "add agent analysis" (I'll generate skill.md)
```

## Strategy Template Library

Built-in templates the builder can draw from:

| Template | Archetype | Core Indicators | Default Route |
|----------|-----------|----------------|---------------|
| Simple DCA | dca | None | L1 |
| Adaptive DCA | dca | RSI + volatility | L1 |
| EMA Crossover | trend-following | EMA(fast) + EMA(slow) | L1 |
| RSI Bounce | mean-reversion | RSI + Bollinger | L1 |
| MACD Momentum | momentum | MACD + signal line | L1 |
| Grid Trading | grid | ATR + price levels | L1 |
| Multi-Factor | multi-factor | RSI + MACD + volume + regime | L2 |
| Regime Adaptive | regime-adaptive | ADX + volatility + multi-TF | L2 |

## Market Adaptation Rules

The builder auto-adapts generated code based on target market:

| Market | Fee Model | Settlement | Lot Size | Price Limits | Special |
|--------|-----------|------------|----------|--------------|---------|
| US Stock | ~0.1% | T+0 | 1 share | None | Pre/post hours |
| Crypto | ~0.1% | T+0 | 0.001+ | None | 24/7 |
| A-Share (CN) | ~0.154% | **T+1** | **100 shares** | **±10%/±20%** | Stamp tax sell-only |
| HK Stock | ~0.24% | T+0/T+2 | **Variable** | None | Lunch break |

For A-share strategies: auto-inject T+1 signal delay, lot rounding to 100, and price limit filters.

## Response Guidelines

- Start by understanding the user's idea — ask questions if vague, don't assume
- Present the technical design in plain language before generating code
- Always wait for confirmation on the design before code generation
- Show the package structure after generation with file sizes
- Run sanity check and report pass/fail transparently
- If L1 is sufficient, say so — don't upsell L2 unnecessarily
- End with clear next steps (backtest, paper trade, or iterate)
- For non-programmers, explain what each generated file does in simple terms

## Risk Disclosures

> Generated strategies are based on historical patterns and user-provided ideas. They require backtesting and paper trading validation before any real capital deployment. The builder generates code mechanically from rules — it does not guarantee profitability. Always validate with Walk-Forward testing (fin-backtest) and paper trading (fin-paper-trading) before going live.

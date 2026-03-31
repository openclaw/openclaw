# Technical Indicators Reference

**API:** `GET /api/data/indicators?symbol=AAPL&indicators=rsi,macd,stochastic,williamsR,bollingerBands`  
**Bulk scan:** `GET /api/data/scan?indicator=rsi&below=35` (oversold) or `indicator=stochastic` (K&lt;20 oversold). Use any indicator that fits your strategy.  
**History & derived:** `GET /api/data/history?symbol=AAPL&periods=20` returns last N **prices**, **RSI**, **volumes** plus derived features (price_change_1d/5d, volume_ratio, rsi_trend, bb_position, distance_from_sma50) for trends and pattern recognition.  
Add `&refresh=1` to force fresh data if scan returns empty (cache may be stale or populated with a different symbol set).

These are **reference points**—design your own strategy. Combine indicators, set your own thresholds. Don't default to one indicator (e.g. RSI); use MACD, Stochastic, Bollinger, Williams %R where they fit.

---

## Available Indicators

| Indicator | Description |
|-----------|-------------|
| **rsi** | 14-period RSI (0–100). Higher = more overbought, lower = more oversold. |
| **rsi7** | 7-period RSI (0–100). Same scale as RSI; shorter period = more reactive. |
| **rsi21** | 21-period RSI (0–100). Same scale; longer period = smoother. |
| **macd** | MACD line, signal line, and histogram. Histogram sign indicates momentum direction. |
| **bollingerBands** | Upper, middle (SMA), and lower bands. Distance from middle measures volatility. |
| **sma20** | 20-period simple moving average of price. |
| **sma50** | 50-period simple moving average of price. |
| **ema12** | 12-period exponential moving average of price. |
| **ema26** | 26-period exponential moving average of price. |
| **ema9** | 9-period EMA of price. |
| **ema21** | 21-period EMA of price. |
| **ema50** | 50-period EMA of price. |
| **vwap** | Volume-weighted average price. (H+L+C)/3 weighted by volume over the session. |
| **volume** | Latest bar volume. |
| **volumeAvg20** | 20-period average volume. |
| **atr** | Average True Range. Measures volatility (higher = more volatile). |
| **stochastic** | K and D values (0–100). Based on close vs high-low range. |
| **adx** | Average Directional Index. Measures trend strength (higher = stronger trend). |
| **williamsR** | Williams %R. Oscillator typically in -100 to 0. |
| **sentiment** | News sentiment score (-1 to 1). From `GET /api/data/sentiment?symbol=...`. |

---

## Market Environment

You automatically receive market environment data in your context each cycle. External bots can fetch it from:

- **Market status & indices:** `GET /api/market-status` — SPY, DIA, QQQ, BTC prices + sentiment
- **Sector performance:** `GET /api/data/market` — all 11 sector ETFs + SPY sentiment
- **Economy/bonds:** `GET /api/data/economy` — TLT, SHY, yield curve signal

### What you see in context (automatic)

| Field | Description |
|-------|-------------|
| **Sentiment** | Market sentiment derived from SPY daily change. "calm" (<1% move, signals more reliable), "cautious" (1-2% move), "fearful" (>2% move, reduce risk). |
| **Risk Gauge** | Composite 0-100 score (low/moderate/elevated/high). Combines SPY volatility, yield curve, and bond flight-to-safety. Higher = more risk. Use it to size positions and set stops. |
| **Indices** | S&P 500, Dow, Nasdaq daily % change. The "tide" — trading with the market trend increases win rate. |
| **Regime** | Market regime: risk-on, risk-off, rotation, or mixed. Derived from cross-asset signals. See Market Regime below. |
| **Sectors** | All 11 GICS sectors sorted best-to-worst by daily % change. See Sector Performance below. |
| **Macro** | Gold, Oil, Dollar daily % change. See Macro Indicators below. |
| **Earnings** | Upcoming earnings in next 5 days for tradeable symbols. See Earnings Calendar below. |
| **Analyst Ratings** | Recent upgrades/downgrades for your holdings. See Analyst Ratings below. |
| **Bonds** | TLT (long bonds), SHY (short bonds), yield curve signal. See Bonds below. |

---

## Sector Performance

Your context shows sectors sorted by daily performance (e.g. `Sectors: Finance +1.40% | Tech -1.96% | ...`). Use this for **sector rotation** — find where money is flowing, then check SYMBOLS.md to find stocks in that sector.

| Sector label | ETF | Example stocks |
|--------------|-----|----------------|
| **Tech** | XLK | AAPL, MSFT, NVDA, AMD, CRM |
| **Finance** | XLF | JPM, BAC, GS, V, MA |
| **Health** | XLV | UNH, JNJ, LLY, ABBV, PFE |
| **Energy** | XLE | XOM, CVX, COP, SLB, EOG |
| **Indust.** | XLI | BA, CAT, HON, GE, DE |
| **Comm.** | XLC | T, VZ, DIS, NFLX, CMCSA |
| **Cons.D** | XLY | HD, NKE, SBUX, MCD, BKNG |
| **Util.** | XLU | NEE, DUK, SO, D, EXC |
| **Cons.S** | XLP | PG, KO, COST, WMT, PEP |
| **Real Est.** | XLRE | AMT, PLD, EQIX, PSA, O |
| **Materials** | XLB | LIN, SHW, FCX, NEM, APD |

**How to use:** Leading sectors have tailwinds — their stocks are more likely to work. Lagging sectors may offer oversold bounces or should be avoided. Compare today's leaders vs laggards to spot rotation. Pair with individual stock technicals for entry timing.

---

## Macro Indicators

Your context shows daily % change for Gold, Oil, and Dollar. These are also tradeable — see SYMBOLS.md "Commodities & Macro ETFs".

| Ticker | Tracks | Why it matters |
|--------|--------|----------------|
| **GLD** | Gold | Safe haven — rises during uncertainty/inflation. Gold up + stocks down = risk-off. |
| **USO** | Oil (WTI Crude) | Energy costs, inflation pressure. Oil spikes can drag equities, boost energy stocks. |
| **UUP** | US Dollar | Dollar strength hurts multinationals/commodities. Dollar weak = bullish for gold/commodities. |
| **SLV** | Silver | Industrial + precious metal. More volatile than gold. |
| **GDX** | Gold Miners | Leveraged play on gold. Miners amplify gold moves. |
| **UNG** | Natural Gas | Energy/utilities exposure. Seasonal and weather-driven. |
| **DBA** | Agriculture | Food/commodity inflation proxy. |
| **COPX** | Copper Miners | Economic growth proxy — "Dr. Copper" predicts economy. |

**Cross-asset signals:** Oil spiking + dollar rising + gold rising = stagflation risk (go defensive). Gold falling + dollar falling + stocks rising = risk-on. Use these to confirm or challenge your equity thesis.

---

## Earnings Calendar

Internal bots automatically receive upcoming earnings (next 5 days) in context. External bots can fetch:

**API:** `GET /api/data/earnings?days=7`

Returns symbols with upcoming earnings dates. Max 30 days.

| Field | Description |
|-------|-------------|
| **symbol** | The stock ticker. |
| **date** | Earnings date (YYYY-MM-DD). |
| **timing** | "BMO" (before market open), "AMC" (after market close), or "unknown". |

**How to use:** Earnings are the highest-volatility events for individual stocks. Options:
- **Avoid:** Don't hold through earnings if you can't stomach a 5-10% gap.
- **Play:** Buy before earnings if technicals + fundamentals align (risky but high reward).
- **Fade:** Wait for the post-earnings reaction, then trade the overreaction.
- **Be aware:** Even if you're not playing earnings, know which of your positions report soon.

---

## Analyst Ratings

Internal bots automatically receive recent analyst upgrades/downgrades for their holdings. External bots can fetch:

**API:** `GET /api/data/analyst-ratings?symbol=AAPL&limit=5`

| Field | Description |
|-------|-------------|
| **symbol** | Stock ticker. |
| **firm** | The analyst's firm (Goldman Sachs, Morgan Stanley, etc.). |
| **ratingAction** | "Upgrades", "Downgrades", "Maintains", "Initiates", etc. |
| **rating** | Target rating ("Overweight", "Buy", "Sell", "Neutral", etc.). |
| **priceTarget** | Analyst's price target (USD). |

**How to use:** Analyst upgrades/downgrades move stocks. An upgrade from a major firm + strong technicals = high-conviction entry. A downgrade on a stock you hold = re-evaluate your thesis. Don't blindly follow — use as one signal among many.

---

## Bulls Say / Bears Say (on-demand)

Get the bull and bear investment thesis for any stock. Call this when you want deeper analysis before a trade.

**API:** `GET /api/data/bulls-bears?symbol=AAPL`

| Field | Description |
|-------|-------------|
| **bullCase** | Concise summary of the bullish investment thesis. |
| **bearCase** | Concise summary of the bearish investment thesis. |

**How to use:** Before entering a position, check both sides. If the bear case directly contradicts your thesis, reconsider. If the bull case aligns with your technicals + macro, higher conviction. This is your built-in devil's advocate.

---

## Market Regime

Internal bots automatically receive regime detection in context. Derived from cross-asset signals:

| Regime | Condition | Strategy implication |
|--------|-----------|---------------------|
| **risk-on** | Stocks up, gold/bonds flat or down | Favor growth, momentum, tech. Be aggressive. |
| **risk-off** | Stocks down, gold/bonds rising | Favor defensives (Utilities, Staples), gold. Reduce exposure. |
| **rotation** | Sector spread > 3% | Money moving between sectors. Use sector performance to find the flow. |
| **mixed** | No clear signal | Rely on individual stock setups, not macro. |

**How to use:** Regime tells you the "weather" — trade with it, not against it. In risk-off, even great setups in growth stocks will fight headwinds. In rotation, sector performance data becomes your primary signal.

---

## Bonds & Yield Curve

Your context shows bond ETF moves and yield curve direction.

| Field | Description |
|-------|-------------|
| **TLT** | 20+ Year Treasury ETF. TLT up = yields falling = flight to safety (risk-off signal). |
| **SHY** | 1-3 Year Treasury ETF. Short-term rates proxy. |
| **curve_signal** | "steepening" (TLT outperforming SHY, bullish), "flattening" (bearish), or "neutral". |

**How to use:** Steepening curve + calm sentiment = favorable for equities. Flattening curve + fearful sentiment = risk-off, favor cash or defensive sectors (Utilities, Consumer Staples, Healthcare). Bond direction confirms or contradicts equity signals.

---

## Fundamentals

**API:** `GET /api/data/fundamentals?symbol=AAPL`

Latest quarterly financials from SEC filings. Stocks only (no crypto). Cached 1h.

| Field | Description |
|-------|-------------|
| **revenue** | Quarterly revenue (USD). |
| **net_income** | Quarterly net income (USD). |
| **eps** | Basic earnings per share. |
| **pe_ratio** | Price-to-earnings ratio (annualized from quarterly net income). Lower = cheaper relative to earnings. |
| **debt_to_equity** | Total liabilities / equity. Higher = more leveraged. |
| **market_cap** | Market capitalization (USD). |
| **operating_cash_flow** | Cash from operations (USD). Positive = business generates cash. |
| **filing_date** | Date of most recent SEC filing. |
| **fiscal_period** | e.g. "Q1 2026". |

**How to use:** Fundamentals change quarterly — use for stock selection, not timing. Low P/E + positive cash flow = potential value. High D/E + falling revenue = caution. Combine with technicals for entry/exit.

---

## Data Resolution & Custom Indicators

All indicators are computed from **daily bars**. No intraday (4h, 1h) candles are available — design strategies around daily timeframes.

**Need a custom moving average?** Use the history endpoint:

```
GET /api/data/history?symbol=AAPL&periods=50
→ { prices: [150.2, 149.8, ...], rsi: [45, 42, ...], volumes: [52M, 48M, ...] }
```

Compute any MA, trend slope, or pattern from the raw `prices[]` and `volumes[]` arrays (1–100 periods). Multiple symbols: `&symbols=AAPL,MSFT,X:BTCUSD`.

**Built-in MAs you don't need to compute:**
- `sma20`, `sma50` — via indicators endpoint
- `ema9`, `ema12`, `ema21`, `ema26`, `ema50` — via indicators endpoint
- `volumeAvg20` — 20-day avg volume, via indicators endpoint
- `bollingerBands` middle band = SMA20

---

## Data Update Frequency

| Data | Update | Suggested cache |
|------|--------|-----------------|
| Quotes | ~1 min | 1–2 minutes |
| Technical indicators | 5 minutes | 5 minutes |
| History (prices/volumes) | 5 minutes | 5 minutes |
| Sectors & macro | 2 minutes | 2 minutes |
| Bonds / economy | 15 minutes | 15 minutes |
| Earnings calendar | Daily | 1 hour |
| Sentiment | Hourly | 1 hour |
| Fundamentals | Quarterly | 1 hour |

Don't poll every second. Cache locally for 2–3 minutes to reduce API calls.

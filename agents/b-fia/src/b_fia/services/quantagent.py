"""Local technical analysis engine using ta library.

Replaces the external QuantAgent API with local RSI/MACD/Bollinger Bands
computation. Uses yfinance for price history and ta for indicators.
"""

from __future__ import annotations

import asyncio
from typing import Optional

import pandas as pd
import ta
import yfinance as yf

from ..models import SignalResult

# Thresholds for signal generation
RSI_OVERSOLD = 30
RSI_OVERBOUGHT = 70
STOP_LOSS_PCT = 0.05  # 5% stop loss
TAKE_PROFIT_PCT = 0.10  # 10% take profit

# Map short periods to longer ones so we have enough data for indicators
PERIOD_MAP = {
    "1d": "5d",
    "5d": "1mo",
    "1mo": "3mo",
    "3mo": "6mo",
    "6mo": "1y",
    "1y": "2y",
    "2y": "5y",
}


class QuantAgentService:
    """Local technical analysis engine using ta library."""

    async def get_signals(self, symbol: str, period: str = "1y") -> SignalResult:
        """Compute buy/sell/hold signals from RSI, MACD, and Bollinger Bands."""
        df = await asyncio.to_thread(_fetch_and_compute, symbol, period)

        if df is None or df.empty:
            raise RuntimeError(f"No price data available for {symbol}")

        latest = df.iloc[-1]
        prev = df.iloc[-2] if len(df) >= 2 else latest
        close = float(latest["Close"])

        # Extract indicator values
        rsi = _safe_float(latest, "rsi")
        macd = _safe_float(latest, "macd")
        macd_signal = _safe_float(latest, "macd_signal")
        macd_hist = _safe_float(latest, "macd_hist")
        macd_hist_prev = _safe_float(prev, "macd_hist")
        bb_upper = _safe_float(latest, "bb_upper")
        bb_lower = _safe_float(latest, "bb_lower")
        bb_mid = _safe_float(latest, "bb_mid")

        # Score-based signal system (-3 to +3)
        score = 0
        rationale_parts = []

        # RSI signal
        if rsi is not None:
            if rsi < RSI_OVERSOLD:
                score += 1
                rationale_parts.append(f"RSI oversold ({rsi:.1f})")
            elif rsi > RSI_OVERBOUGHT:
                score -= 1
                rationale_parts.append(f"RSI overbought ({rsi:.1f})")
            else:
                rationale_parts.append(f"RSI neutral ({rsi:.1f})")

        # MACD signal
        if macd is not None and macd_signal is not None:
            if macd > macd_signal:
                score += 1
                rationale_parts.append("MACD bullish crossover")
            else:
                score -= 1
                rationale_parts.append("MACD bearish crossover")

            if macd_hist is not None and macd_hist_prev is not None:
                if macd_hist > 0 and macd_hist_prev <= 0:
                    score += 1
                    rationale_parts.append("MACD histogram turned positive")
                elif macd_hist < 0 and macd_hist_prev >= 0:
                    score -= 1
                    rationale_parts.append("MACD histogram turned negative")

        # Bollinger Bands signal
        if bb_upper is not None and bb_lower is not None:
            if close <= bb_lower:
                score += 1
                rationale_parts.append("Price at lower Bollinger Band (potential bounce)")
            elif close >= bb_upper:
                score -= 1
                rationale_parts.append("Price at upper Bollinger Band (potential pullback)")

        # Determine action and confidence
        if score >= 2:
            action = "Buy"
        elif score <= -2:
            action = "Sell"
        else:
            action = "Hold"

        confidence = min(abs(score) / 3.0, 1.0)

        # Risk level based on Bollinger Band width (volatility proxy)
        risk_level = "Medium"
        if bb_mid is not None and bb_mid > 0 and bb_upper is not None and bb_lower is not None:
            bb_width = (bb_upper - bb_lower) / bb_mid
            if bb_width > 0.10:
                risk_level = "High"
            elif bb_width < 0.04:
                risk_level = "Low"

        # Calculate entry, stop loss, take profit
        entry_price = close
        if action == "Buy":
            stop_loss = round(close * (1 - STOP_LOSS_PCT), 2)
            take_profit = round(close * (1 + TAKE_PROFIT_PCT), 2)
        else:
            stop_loss = round(close * (1 + STOP_LOSS_PCT), 2)
            take_profit = round(close * (1 - TAKE_PROFIT_PCT), 2)

        return SignalResult(
            symbol=symbol,
            action=action,
            confidence=round(confidence, 2),
            entry_price=round(entry_price, 2),
            stop_loss=stop_loss,
            take_profit=take_profit,
            risk_level=risk_level,
            rationale="; ".join(rationale_parts),
        )


def _fetch_and_compute(symbol: str, period: str) -> Optional[pd.DataFrame]:
    """Download price history and compute technical indicators."""
    fetch_period = PERIOD_MAP.get(period, "2y")
    ticker = yf.Ticker(symbol)
    df = ticker.history(period=fetch_period)

    if df is None or df.empty:
        return None

    # RSI (14-period)
    df["rsi"] = ta.momentum.RSIIndicator(close=df["Close"], window=14).rsi()

    # MACD (12, 26, 9)
    macd_ind = ta.trend.MACD(close=df["Close"], window_slow=26, window_fast=12, window_sign=9)
    df["macd"] = macd_ind.macd()
    df["macd_signal"] = macd_ind.macd_signal()
    df["macd_hist"] = macd_ind.macd_diff()

    # Bollinger Bands (20, 2.0)
    bb_ind = ta.volatility.BollingerBands(close=df["Close"], window=20, window_dev=2)
    df["bb_upper"] = bb_ind.bollinger_hband()
    df["bb_lower"] = bb_ind.bollinger_lband()
    df["bb_mid"] = bb_ind.bollinger_mavg()

    return df


def _safe_float(row: pd.Series, col: str) -> Optional[float]:
    """Extract a float from a DataFrame row, returning None if missing/NaN."""
    if col not in row.index:
        return None
    val = row[col]
    if pd.isna(val):
        return None
    return float(val)

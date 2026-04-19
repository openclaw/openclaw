"""Market data service using yfinance.

Fetches price, fundamentals, and technical indicators directly from
Yahoo Finance. No API key required.
"""

from __future__ import annotations

import asyncio
from typing import Optional

import yfinance as yf

from ..models import MarketData


class OpenBBService:
    """Market data fetcher using yfinance (Yahoo Finance)."""

    async def fetch(self, symbol: str, period: str = "1y") -> MarketData:
        """Fetch price, fundamentals, and RSI for a given symbol."""
        info, rsi = await asyncio.gather(
            asyncio.to_thread(_fetch_info, symbol),
            asyncio.to_thread(_compute_rsi, symbol),
        )

        if not info:
            raise RuntimeError(f"No market data available for {symbol}")

        return MarketData(
            symbol=symbol,
            price=info.get("currentPrice") or info.get("regularMarketPrice"),
            change_pct=info.get("regularMarketChangePercent"),
            rsi=rsi,
            volume=info.get("volume"),
            market_cap=info.get("marketCap"),
            pe_ratio=info.get("trailingPE"),
            revenue=info.get("totalRevenue"),
            net_income=info.get("netIncomeToCommon"),
            period_label=period,
        )


def _fetch_info(symbol: str) -> Optional[dict]:
    """Fetch ticker info from yfinance."""
    try:
        ticker = yf.Ticker(symbol)
        info = ticker.info
        if not info or info.get("regularMarketPrice") is None and info.get("currentPrice") is None:
            return None
        return info
    except Exception:
        return None


def _compute_rsi(symbol: str, window: int = 14) -> Optional[float]:
    """Compute RSI from recent price history."""
    try:
        ticker = yf.Ticker(symbol)
        hist = ticker.history(period="3mo")
        if hist is None or len(hist) < window + 1:
            return None

        delta = hist["Close"].diff()
        gain = delta.where(delta > 0, 0.0).rolling(window=window).mean()
        loss = (-delta.where(delta < 0, 0.0)).rolling(window=window).mean()

        last_gain = gain.iloc[-1]
        last_loss = loss.iloc[-1]

        if last_loss == 0:
            return 100.0
        rs = last_gain / last_loss
        return round(100.0 - (100.0 / (1.0 + rs)), 1)
    except Exception:
        return None

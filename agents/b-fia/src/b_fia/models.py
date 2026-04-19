"""Pydantic models for B-FIA requests and responses."""

from __future__ import annotations

from typing import Dict, List, Optional

from pydantic import BaseModel, Field


# ---------- Request ----------


class AnalyzeRequest(BaseModel):
    """Common request body for all analysis endpoints."""

    symbol: str = Field(..., description="Stock ticker symbol, e.g. NVDA")
    channel: str = Field("", description='Target channel format: "slack", "line", or "" for raw JSON')
    period: str = Field("1y", description="Lookback period, e.g. 1d, 5d, 1mo, 3mo, 1y")


# ---------- Service results ----------


class MarketData(BaseModel):
    """Result from OpenBB: price and technical data."""

    symbol: str
    price: Optional[float] = None
    change_pct: Optional[float] = None
    rsi: Optional[float] = None
    volume: Optional[int] = None
    market_cap: Optional[float] = None
    pe_ratio: Optional[float] = None
    revenue: Optional[float] = None
    net_income: Optional[float] = None
    period_label: str = ""


class SentimentResult(BaseModel):
    """Result from FinGPT: sentiment analysis."""

    symbol: str
    score: float = Field(0.0, ge=-1.0, le=1.0, description="Sentiment score from -1 (bearish) to 1 (bullish)")
    label: str = ""  # "bullish", "bearish", "neutral"
    headlines: List[str] = Field(default_factory=list)
    summary: str = ""


class SignalResult(BaseModel):
    """Result from QuantAgent: trade signals."""

    symbol: str
    action: str = ""  # "Buy", "Sell", "Hold"
    confidence: float = 0.0
    entry_price: Optional[float] = None
    stop_loss: Optional[float] = None
    take_profit: Optional[float] = None
    risk_level: str = ""  # "Low", "Medium", "High"
    rationale: str = ""


# ---------- Source error ----------


class SourceError(BaseModel):
    """Error from an individual data source."""

    service: str
    error: str


# ---------- Orchestrated response ----------


class AnalysisResult(BaseModel):
    """Full orchestrated analysis result."""

    symbol: str
    market_data: Optional[MarketData] = None
    sentiment: Optional[SentimentResult] = None
    signals: Optional[SignalResult] = None
    synthesis: str = ""
    divergence_warning: bool = False
    divergence_detail: str = ""
    source_errors: List[SourceError] = Field(default_factory=list)
    generated_at: str = ""


class ReportResult(BaseModel):
    """Full analysis with channel-formatted output."""

    analysis: AnalysisResult
    formatted: Optional[Dict] = None  # Channel-specific payload (Block Kit / Flex Message)
    summary: str = ""  # Short text summary

"""Core orchestrator: concurrent service calls, divergence detection, synthesis."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple

from .formatters.line import format_line
from .formatters.slack import format_slack
from .models import (
    AnalysisResult,
    MarketData,
    ReportResult,
    SentimentResult,
    SignalResult,
    SourceError,
)
from .services.fingpt import FinGPTService
from .services.openbb import OpenBBService
from .services.quantagent import QuantAgentService

SENTIMENT_DIVERGENCE_THRESHOLD = 0.3


def _detect_divergence(
    sentiment: Optional[SentimentResult],
    signals: Optional[SignalResult],
) -> Tuple[bool, str]:
    """Check if sentiment and technical signals contradict each other."""
    if not sentiment or not signals or not signals.action:
        return False, ""

    score = sentiment.score
    action = signals.action.lower()

    # Bullish sentiment but Sell signal
    if score > SENTIMENT_DIVERGENCE_THRESHOLD and action == "sell":
        return True, (
            f"Divergence Warning: FinGPT sentiment is bullish ({score:+.2f}) "
            f"but QuantAgent signals Sell. Exercise caution."
        )

    # Bearish sentiment but Buy signal
    if score < -SENTIMENT_DIVERGENCE_THRESHOLD and action == "buy":
        return True, (
            f"Divergence Warning: FinGPT sentiment is bearish ({score:+.2f}) "
            f"but QuantAgent signals Buy. Exercise caution."
        )

    return False, ""


def _synthesize(
    market_data: Optional[MarketData],
    sentiment: Optional[SentimentResult],
    signals: Optional[SignalResult],
    divergence: bool,
) -> str:
    """Generate a brief actionable synthesis from all three data sources."""
    parts: List[str] = []

    if market_data and market_data.price is not None:
        price_str = f"${market_data.price:,.2f}"
        change = f" ({market_data.change_pct:+.2f}%)" if market_data.change_pct is not None else ""
        parts.append(f"Price: {price_str}{change}")
        if market_data.rsi is not None:
            parts.append(f"RSI: {market_data.rsi:.1f}")

    if sentiment:
        parts.append(f"Sentiment: {sentiment.label} ({sentiment.score:+.2f})")

    if signals and signals.action:
        parts.append(f"Signal: {signals.action} (confidence {signals.confidence:.0%})")
        if signals.risk_level:
            parts.append(f"Risk: {signals.risk_level}")

    if divergence:
        parts.append("** DIVERGENCE between sentiment and technical signals **")

    return " | ".join(parts) if parts else "Insufficient data for synthesis."


async def run_analysis(symbol: str, period: str = "1y") -> AnalysisResult:
    """Run the full analysis pipeline concurrently."""
    openbb = OpenBBService()
    fingpt = FinGPTService()
    quantagent = QuantAgentService()

    source_errors: List[SourceError] = []
    market_data: Optional[MarketData] = None
    sentiment: Optional[SentimentResult] = None
    signals: Optional[SignalResult] = None

    # Run all three services concurrently, catch individual failures
    results = await asyncio.gather(
        _safe_call("openbb", openbb.fetch(symbol, period)),
        _safe_call("fingpt", fingpt.analyze(symbol)),
        _safe_call("quantagent", quantagent.get_signals(symbol, period)),
        return_exceptions=False,
    )

    for service_name, result in results:
        if isinstance(result, Exception):
            source_errors.append(SourceError(service=service_name, error=str(result)))
        elif isinstance(result, MarketData):
            market_data = result
        elif isinstance(result, SentimentResult):
            sentiment = result
        elif isinstance(result, SignalResult):
            signals = result

    divergence, divergence_detail = _detect_divergence(sentiment, signals)

    return AnalysisResult(
        symbol=symbol,
        market_data=market_data,
        sentiment=sentiment,
        signals=signals,
        synthesis=_synthesize(market_data, sentiment, signals, divergence),
        divergence_warning=divergence,
        divergence_detail=divergence_detail,
        source_errors=source_errors,
        generated_at=datetime.now(timezone.utc).isoformat(),
    )


async def run_report(symbol: str, period: str = "1y", channel: str = "") -> ReportResult:
    """Run full analysis and format for the target channel."""
    analysis = await run_analysis(symbol, period)

    formatted: Optional[Dict] = None
    if channel == "slack":
        formatted = format_slack(analysis)
    elif channel == "line":
        formatted = format_line(analysis)

    return ReportResult(
        analysis=analysis,
        formatted=formatted,
        summary=analysis.synthesis,
    )


async def _safe_call(
    service_name: str,
    coro: object,
) -> Tuple[str, object]:
    """Wrap a coroutine to catch exceptions without failing the gather."""
    try:
        result = await coro  # type: ignore[misc]
        return (service_name, result)
    except Exception as exc:
        return (service_name, exc)

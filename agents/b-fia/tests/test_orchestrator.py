"""Tests for the B-FIA orchestrator and divergence detection."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from b_fia.models import MarketData, SentimentResult, SignalResult
from b_fia.orchestrator import _detect_divergence, _synthesize, run_analysis


class TestDivergenceDetection:
    def test_no_divergence_bullish_buy(self):
        sentiment = SentimentResult(symbol="NVDA", score=0.5, label="bullish")
        signals = SignalResult(symbol="NVDA", action="Buy", confidence=0.8)
        diverged, detail = _detect_divergence(sentiment, signals)
        assert not diverged
        assert detail == ""

    def test_divergence_bullish_sell(self):
        sentiment = SentimentResult(symbol="NVDA", score=0.5, label="bullish")
        signals = SignalResult(symbol="NVDA", action="Sell", confidence=0.8)
        diverged, detail = _detect_divergence(sentiment, signals)
        assert diverged
        assert "Divergence Warning" in detail

    def test_divergence_bearish_buy(self):
        sentiment = SentimentResult(symbol="NVDA", score=-0.5, label="bearish")
        signals = SignalResult(symbol="NVDA", action="Buy", confidence=0.7)
        diverged, detail = _detect_divergence(sentiment, signals)
        assert diverged
        assert "bearish" in detail

    def test_no_divergence_when_neutral(self):
        sentiment = SentimentResult(symbol="NVDA", score=0.1, label="neutral")
        signals = SignalResult(symbol="NVDA", action="Sell", confidence=0.6)
        diverged, _ = _detect_divergence(sentiment, signals)
        assert not diverged

    def test_no_divergence_when_missing_data(self):
        diverged, _ = _detect_divergence(None, None)
        assert not diverged


class TestSynthesize:
    def test_full_synthesis(self):
        md = MarketData(symbol="NVDA", price=850.0, change_pct=2.5, rsi=65.0)
        sentiment = SentimentResult(symbol="NVDA", score=0.4, label="bullish")
        signals = SignalResult(symbol="NVDA", action="Buy", confidence=0.85, risk_level="Medium")

        result = _synthesize(md, sentiment, signals, divergence=False)
        assert "$850.00" in result
        assert "bullish" in result
        assert "Buy" in result

    def test_empty_synthesis(self):
        result = _synthesize(None, None, None, divergence=False)
        assert "Insufficient data" in result

    def test_divergence_in_synthesis(self):
        md = MarketData(symbol="NVDA", price=850.0)
        result = _synthesize(md, None, None, divergence=True)
        assert "DIVERGENCE" in result


class TestRunAnalysis:
    @pytest.mark.asyncio
    async def test_handles_all_service_failures(self):
        """When all services fail, analysis returns errors without crashing."""
        with (
            patch("b_fia.orchestrator.OpenBBService") as mock_openbb,
            patch("b_fia.orchestrator.FinGPTService") as mock_fingpt,
            patch("b_fia.orchestrator.QuantAgentService") as mock_quant,
        ):
            mock_openbb.return_value.fetch = AsyncMock(side_effect=RuntimeError("no key"))
            mock_fingpt.return_value.analyze = AsyncMock(side_effect=RuntimeError("no key"))
            mock_quant.return_value.get_signals = AsyncMock(side_effect=RuntimeError("no key"))

            result = await run_analysis("NVDA")

        assert result.symbol == "NVDA"
        assert result.market_data is None
        assert result.sentiment is None
        assert result.signals is None
        assert len(result.source_errors) == 3

    @pytest.mark.asyncio
    async def test_partial_success(self):
        """When one service fails, others still return data."""
        mock_md = MarketData(symbol="NVDA", price=850.0, rsi=65.0)

        with (
            patch("b_fia.orchestrator.OpenBBService") as mock_openbb,
            patch("b_fia.orchestrator.FinGPTService") as mock_fingpt,
            patch("b_fia.orchestrator.QuantAgentService") as mock_quant,
        ):
            mock_openbb.return_value.fetch = AsyncMock(return_value=mock_md)
            mock_fingpt.return_value.analyze = AsyncMock(side_effect=RuntimeError("timeout"))
            mock_quant.return_value.get_signals = AsyncMock(side_effect=RuntimeError("timeout"))

            result = await run_analysis("NVDA")

        assert result.market_data is not None
        assert result.market_data.price == 850.0
        assert result.sentiment is None
        assert len(result.source_errors) == 2

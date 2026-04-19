"""Financial sentiment analysis using LLM.

Fetches recent news headlines via yfinance, then asks the LLM to score
overall sentiment on a -1 (bearish) to +1 (bullish) scale.

Supported providers (set via SENTIMENT_PROVIDER env var):
  - "ollama"  — local Ollama instance (default, free)
  - "openai"  — OpenAI public API (requires OPENAI_API_KEY + credits)
  - "claude"  — Anthropic Claude API (requires ANTHROPIC_API_KEY)
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Dict, List, Optional

import httpx
import yfinance as yf

from ..config import settings
from ..models import SentimentResult

SENTIMENT_PROMPT = """You are a financial sentiment analyst. Analyze the following news headlines for {symbol} and provide:

1. A sentiment score from -1.0 (extremely bearish) to +1.0 (extremely bullish)
2. A one-sentence summary of overall sentiment
3. The 3 most impactful headlines

Headlines:
{headlines}

Respond in this exact JSON format only, no other text:
{{"score": 0.0, "summary": "...", "top_headlines": ["...", "...", "..."]}}"""

class FinGPTService:
    """Financial sentiment analysis powered by LLM."""

    def __init__(
        self,
        provider: Optional[str] = None,
        api_key: Optional[str] = None,
    ) -> None:
        self.provider = provider or settings.sentiment_provider

        if self.provider == "claude":
            self.api_key = api_key or settings.anthropic_api_key
            self.model = settings.anthropic_model
        elif self.provider == "ollama":
            self.api_key = ""
            self.model = settings.ollama_model
        else:
            self.api_key = api_key or settings.openai_api_key
            self.model = settings.openai_model

    async def analyze(self, symbol: str) -> SentimentResult:
        """Fetch news and run LLM sentiment analysis."""
        if self.provider not in ("ollama",) and not self.api_key:
            key_name = "ANTHROPIC_API_KEY" if self.provider == "claude" else "OPENAI_API_KEY"
            raise RuntimeError(f"Sentiment API key is not configured ({key_name})")

        headlines = await asyncio.to_thread(_fetch_news_headlines, symbol)

        if not headlines:
            return SentimentResult(
                symbol=symbol,
                score=0.0,
                label="neutral",
                headlines=[],
                summary=f"No recent news found for {symbol}",
            )

        prompt = SENTIMENT_PROMPT.format(
            symbol=symbol,
            headlines="\n".join(f"- {h}" for h in headlines),
        )

        if self.provider == "ollama":
            data = await self._call_ollama(prompt)
        elif self.provider == "claude":
            data = await self._call_claude(prompt)
        else:
            data = await self._call_openai(prompt)

        score = float(data.get("score", 0.0))
        score = max(-1.0, min(1.0, score))

        if score > 0.2:
            label = "bullish"
        elif score < -0.2:
            label = "bearish"
        else:
            label = "neutral"

        return SentimentResult(
            symbol=symbol,
            score=round(score, 2),
            label=label,
            headlines=data.get("top_headlines", headlines[:3]),
            summary=data.get("summary", ""),
        )

    async def _call_ollama(self, prompt: str) -> Dict[str, Any]:
        """Call local Ollama API."""
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                f"{settings.ollama_base_url}/api/chat",
                json={
                    "model": self.model,
                    "messages": [{"role": "user", "content": prompt}],
                    "stream": False,
                    "format": "json",
                },
            )
            resp.raise_for_status()
            body = resp.json()

        content = body.get("message", {}).get("content", "{}")
        return _parse_json_response(content)

    async def _call_openai(self, prompt: str) -> Dict[str, Any]:
        """Call OpenAI public API."""
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                f"{settings.openai_base_url}/chat/completions",
                json={
                    "model": self.model,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.1,
                    "response_format": {"type": "json_object"},
                },
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
            )
            resp.raise_for_status()
            body = resp.json()

        content = body["choices"][0]["message"]["content"]
        return _parse_json_response(content)

    async def _call_claude(self, prompt: str) -> Dict[str, Any]:
        """Call Anthropic messages API."""
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.post(
                "https://api.anthropic.com/v1/messages",
                json={
                    "model": self.model,
                    "max_tokens": 512,
                    "messages": [{"role": "user", "content": prompt}],
                },
                headers={
                    "x-api-key": self.api_key,
                    "anthropic-version": "2023-06-01",
                    "Content-Type": "application/json",
                },
            )
            resp.raise_for_status()
            body = resp.json()

        content = body["content"][0]["text"]
        return _parse_json_response(content)


def _parse_json_response(content: str) -> Dict[str, Any]:
    """Parse JSON from LLM response, stripping code fences if present."""
    text = content.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    return json.loads(text)


def _fetch_news_headlines(symbol: str, max_items: int = 15) -> List[str]:
    """Fetch recent news headlines from yfinance."""
    ticker = yf.Ticker(symbol)
    news = ticker.news or []

    headlines = []
    for item in news[:max_items]:
        content = item.get("content", item)
        title = content.get("title", "") if isinstance(content, dict) else item.get("title", "")
        if title:
            headlines.append(title)

    return headlines

"""
OpenClaw TradingAgents bridge.

This service wraps TauricResearch/TradingAgents as a read-only strategy signal
source. The default provider is simulated, so OpenClaw can start and validate
the integration before any third-party package, LLM key, or market data source is
installed.

報價優先級：
  1. 群益 API (CapitalHftService os_symbol_cache.json) — 台期/海期即時報價
  2. OKX REST API — 加密貨幣即時報價
  3. 策略引擎傳入的 payload bars — 即時 tick 資料
  4. TradingAgents 內建源 (Yahoo/news/fundamentals) — 輔助分析
"""

from __future__ import annotations

import argparse
import json
import traceback
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
STATE_PATH = REPO_ROOT / "reports" / "hermes-agent" / "state" / "openclaw-tradingagents-bridge-latest.json"
SIGNAL_SCHEMA = "openclaw.tradingagents.signal.v1"
HEALTH_SCHEMA = "openclaw.tradingagents.bridge.health.v1"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def finite_number(value: Any, default: float = 0.0) -> float:
    try:
        num = float(value)
    except (TypeError, ValueError):
        return float(default)
    if num != num:  # NaN
        return float(default)
    if num == float("inf") or num == float("-inf"):
        return float(default)
    return num


def normalize_bar(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raw = {}
    close = finite_number(raw.get("close", raw.get("price", 0.0)), 0.0)
    open_price = finite_number(raw.get("open", close), close)
    high = finite_number(raw.get("high", close), close)
    low = finite_number(raw.get("low", close), close)
    volume = max(0.0, finite_number(raw.get("volume", 0.0), 0.0))
    return {
        "open": open_price,
        "high": high,
        "low": low,
        "close": close,
        "volume": volume,
        "time": str(raw.get("time") or ""),
    }


def parse_recent_bars(payload: dict[str, Any], limit: int = 40) -> list[dict[str, Any]]:
    bars = payload.get("recentBars")
    if not isinstance(bars, list):
        return []
    out: list[dict[str, Any]] = []
    for item in bars[-max(1, limit) :]:
        bar = normalize_bar(item)
        if bar["close"] <= 0:
            continue
        out.append(bar)
    return out


# === 群益報價讀取器 ===
class CapitalQuoteReader:
    """讀取 CapitalHftService 的 os_symbol_cache.json，取得台期/海期即時報價。"""

    MAX_FRESH_SECONDS = 300  # 5 分鐘內視為新鮮

    def __init__(self, state_dir: str | Path | None = None):
        if state_dir:
            self._state_dir = Path(state_dir)
        else:
            # 自動偵測：D:\群益及元大API\CapitalHftService
            candidates = [
                Path(r"D:\群益及元大API\CapitalHftService"),
                REPO_ROOT / ".." / "群益及元大API" / "CapitalHftService",
            ]
            self._state_dir = next((p for p in candidates if p.exists()), candidates[0])
        self._cache_path = self._state_dir / "os_symbol_cache.json"
        self._event_path = self._state_dir / "os_latest_quote_event.json"

    def get_quote(self, symbol: str) -> dict[str, Any] | None:
        """取得單一商品報價，symbol 如 'TX00', 'NQ0000', 'CN0000'。"""
        cache = self._read_cache()
        if not cache:
            return None
        # 檢查 cache 新鮮度
        generated_at = cache.get("generatedAt", "")
        if not self._is_fresh(generated_at):
            return None
        symbols = cache.get("symbols", {})
        # 嘗試完全匹配 + 模糊匹配 (TX00 → TX0000)
        entry = symbols.get(symbol) or symbols.get(symbol + "00")
        if not entry:
            # 嘗試 root 匹配
            upper = symbol.upper()
            for k, v in symbols.items():
                if k.upper().startswith(upper):
                    entry = v
                    break
        if not entry or finite_number(entry.get("price", 0)) <= 0:
            return None
        return {
            "source": "capital_os_symbol_cache",
            "symbol": entry.get("symbol", symbol),
            "name": entry.get("name", ""),
            "price": finite_number(entry.get("price", 0)),
            "bid": finite_number(entry.get("bid", 0)),
            "ask": finite_number(entry.get("ask", 0)),
            "volume": finite_number(entry.get("qty", 0)),
            "time": entry.get("time", ""),
        }

    def get_all_quotes(self) -> dict[str, dict[str, Any]]:
        """取得所有新鮮報價。"""
        cache = self._read_cache()
        if not cache or not self._is_fresh(cache.get("generatedAt", "")):
            return {}
        result = {}
        for k, v in cache.get("symbols", {}).items():
            price = finite_number(v.get("price", 0))
            if price > 0:
                result[k] = {
                    "source": "capital_os_symbol_cache",
                    "symbol": k,
                    "name": v.get("name", ""),
                    "price": price,
                    "bid": finite_number(v.get("bid", 0)),
                    "ask": finite_number(v.get("ask", 0)),
                    "volume": finite_number(v.get("qty", 0)),
                    "time": v.get("time", ""),
                }
        return result

    def _read_cache(self) -> dict[str, Any] | None:
        try:
            raw = self._cache_path.read_text("utf-8").strip()
            return json.loads(raw) if raw else None
        except Exception:
            return None

    def _is_fresh(self, timestamp: str) -> bool:
        try:
            dt = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
            age = (datetime.now(timezone.utc) - dt.astimezone(timezone.utc)).total_seconds()
            return 0 <= age <= self.MAX_FRESH_SECONDS
        except Exception:
            return False


# === OKX 報價讀取器 ===
class OkxQuoteReader:
    """透過 OKX 公開 REST API 取得加密貨幣即時報價，不需 API key。"""

    BASE_URL = "https://www.okx.com/api/v5/market/ticker"
    TIMEOUT = 5  # 秒

    def get_quote(self, inst_id: str) -> dict[str, Any] | None:
        """取得單一商品報價，inst_id 如 'BTC-USDT', 'ETH-USDT'。"""
        try:
            url = f"{self.BASE_URL}?instId={inst_id}"
            req = urllib.request.Request(url, headers={"User-Agent": "OpenClaw/1.0"})
            with urllib.request.urlopen(req, timeout=self.TIMEOUT) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            tickers = data.get("data", [])
            if not tickers:
                return None
            t = tickers[0]
            return {
                "source": "okx_rest_api",
                "symbol": t.get("instId", inst_id),
                "price": finite_number(t.get("last", 0)),
                "bid": finite_number(t.get("bidPx", 0)),
                "ask": finite_number(t.get("askPx", 0)),
                "volume": finite_number(t.get("vol24h", 0)),
                "time": t.get("ts", ""),
            }
        except Exception:
            return None

    def get_quotes(self, inst_ids: list[str]) -> dict[str, dict[str, Any]]:
        """批次取得多商品報價。"""
        result = {}
        for inst_id in inst_ids:
            q = self.get_quote(inst_id)
            if q:
                result[inst_id] = q
        return result


# === 報價合併器 ===
def merge_quote_into_bars(
    bars: list[dict[str, Any]],
    quote: dict[str, Any] | None,
) -> list[dict[str, Any]]:
    """將即時報價插入為最新一根 bar，與 payload bars 合併。"""
    if not quote or finite_number(quote.get("price", 0)) <= 0:
        return bars
    new_bar = {
        "open": finite_number(quote.get("price")),
        "high": finite_number(quote.get("price")),
        "low": finite_number(quote.get("price")),
        "close": finite_number(quote.get("price")),
        "volume": finite_number(quote.get("volume", 0)),
        "time": quote.get("time", utc_now()),
    }
    # 如果已有 bars 且最後一根時間相同，更新而非追加
    if bars and bars[-1].get("close") == new_bar["close"]:
        return bars
    return bars + [new_bar]


def tradingagents_import_status() -> tuple[bool, str | None]:
    try:
        from tradingagents.default_config import DEFAULT_CONFIG  # noqa: F401
        from tradingagents.graph.trading_graph import TradingAgentsGraph  # noqa: F401

        return True, None
    except Exception as exc:  # pragma: no cover - depends on local Python env
        return False, str(exc)


@dataclass
class BridgeConfig:
    host: str
    port: int
    provider: str
    llm_provider: str
    model: str
    quick_model: str
    max_debate: int
    output_language: str
    strict_upstream: bool

    @property
    def uses_upstream(self) -> bool:
        return self.provider != "simulated"


def build_signal(
    *,
    config: BridgeConfig,
    ticker: str,
    trade_date: str,
    source: str,
    signal: str = "HOLD",
    confidence: float = 0.0,
    reason: str = "",
    raw_decision: Any = None,
    error: str | None = None,
) -> dict[str, Any]:
    normalized = str(signal or "HOLD").upper().strip()
    if normalized not in {"BUY", "SELL", "HOLD"}:
        normalized = "HOLD"
    return {
        "schema": SIGNAL_SCHEMA,
        "generatedAt": utc_now(),
        "mode": "paper_signal_only",
        "source": source,
        "provider": config.provider,
        "llmProvider": config.llm_provider,
        "model": config.model,
        "ticker": ticker,
        "trade_date": trade_date,
        "signal": normalized,
        "confidence": float(confidence or 0.0),
        "reason": reason or "No actionable TradingAgents decision.",
        "rawDecision": raw_decision,
        "noOrderWrite": True,
        "brokerWriteAttempted": False,
        "allowLiveTrading": False,
        "writeBrokerOrders": False,
        "error": error,
    }


class TradingAgentsService:
    def __init__(self, config: BridgeConfig):
        self.config = config
        self.upstream_available, self.upstream_error = tradingagents_import_status()
        self.graph = None
        # 主報價源：群益 + OKX
        self.capital_reader = CapitalQuoteReader()
        self.okx_reader = OkxQuoteReader()

        if not config.uses_upstream:
            return

        if not self.upstream_available:
            if config.strict_upstream:
                raise RuntimeError(f"TradingAgents unavailable: {self.upstream_error}")
            return

        from tradingagents.default_config import DEFAULT_CONFIG
        from tradingagents.graph.trading_graph import TradingAgentsGraph

        ta_config = DEFAULT_CONFIG.copy()
        ta_config["llm_provider"] = config.llm_provider
        ta_config["deep_think_llm"] = config.model
        ta_config["quick_think_llm"] = config.quick_model
        ta_config["max_debate_rounds"] = config.max_debate
        ta_config["max_risk_discuss_rounds"] = config.max_debate
        ta_config["output_language"] = config.output_language
        if config.llm_provider == "ollama":
            ta_config.setdefault("backend_url", "http://localhost:11434/v1")

        self.graph = TradingAgentsGraph(
            selected_analysts=["market", "news", "fundamentals"],
            debug=False,
            config=ta_config,
        )

    def health(self) -> dict[str, Any]:
        # 檢查主報價源可用性
        capital_quotes = self.capital_reader.get_all_quotes()
        okx_test = self.okx_reader.get_quote("BTC-USDT")
        return {
            "schema": HEALTH_SCHEMA,
            "generatedAt": utc_now(),
            "status": "ok" if self.graph or not self.config.uses_upstream else "degraded",
            "mode": "paper_signal_only",
            "provider": self.config.provider,
            "llmProvider": self.config.llm_provider,
            "model": self.config.model,
            "tradingAgentsAvailable": self.upstream_available,
            "tradingAgentsActive": self.graph is not None,
            "upstreamError": self.upstream_error,
            "primaryQuoteSources": {
                "capital": {
                    "available": len(capital_quotes) > 0,
                    "symbolCount": len(capital_quotes),
                    "symbols": list(capital_quotes.keys())[:10],
                },
                "okx": {
                    "available": okx_test is not None,
                    "samplePrice": okx_test.get("price") if okx_test else None,
                },
            },
            "auxiliarySources": ["tradingagents_news", "tradingagents_fundamentals", "tradingagents_market"],
            "noOrderWrite": True,
            "brokerWriteAttempted": False,
            "allowLiveTrading": False,
            "writeBrokerOrders": False,
        }

    def analyze(self, payload: dict[str, Any]) -> dict[str, Any]:
        ticker = str(payload.get("ticker") or payload.get("instrument") or "NVDA").strip()
        fallback_ticker = str(payload.get("fallbackTicker") or ticker).strip()
        trade_date = str(payload.get("trade_date") or datetime.now().strftime("%Y-%m-%d")).strip()
        broker = str(payload.get("broker") or "").strip().lower()

        # === 主報價源注入：群益 + OKX ===
        live_quote = None
        live_source = ""
        if broker == "capital" or payload.get("marketDataSource") == "capital":
            live_quote = self.capital_reader.get_quote(ticker)
            live_source = "capital"
        elif broker == "okx":
            inst_id = payload.get("instrument") or ticker
            live_quote = self.okx_reader.get_quote(inst_id)
            live_source = "okx"

        # 合併即時報價至 payload bars
        if live_quote:
            existing_bars = parse_recent_bars(payload, limit=40)
            merged_bars = merge_quote_into_bars(existing_bars, live_quote)
            payload = {**payload, "recentBars": merged_bars}
            payload.setdefault("_liveQuote", live_quote)
            payload.setdefault("_liveSource", live_source)

        capital_signal = self._capital_context_signal(payload, ticker, trade_date)
        if capital_signal is not None:
            # 附加即時報價資訊
            if live_quote:
                capital_signal["liveQuote"] = live_quote
                capital_signal["liveSource"] = live_source
            return capital_signal

        if self.graph is None:
            source = "simulated_bridge" if not self.config.uses_upstream else "fallback_no_tradingagents"
            reason = (
                "TradingAgents bridge is running in simulated read-only mode."
                if not self.config.uses_upstream
                else f"TradingAgents package is unavailable, fallback HOLD: {self.upstream_error}"
            )
            return build_signal(
                config=self.config,
                ticker=ticker,
                trade_date=trade_date,
                source=source,
                reason=reason,
                raw_decision={"input": payload},
                error=self.upstream_error if self.config.uses_upstream else None,
            )

        try:
            _, decision = self.graph.propagate(fallback_ticker, trade_date)
            signal = self._decision_to_signal(ticker, trade_date, decision)
            signal["upstreamTicker"] = fallback_ticker
            if live_quote:
                signal["liveQuote"] = live_quote
                signal["liveSource"] = live_source
            return signal
        except Exception as exc:  # pragma: no cover - depends on upstream runtime
            traceback.print_exc()
            return build_signal(
                config=self.config,
                ticker=ticker,
                trade_date=trade_date,
                source="tradingagents_error",
                reason=f"TradingAgents runtime error: {exc}",
                error=str(exc),
            )

    def _capital_context_signal(
        self,
        payload: dict[str, Any],
        ticker: str,
        trade_date: str,
    ) -> dict[str, Any] | None:
        broker = str(payload.get("broker") or "").strip().lower()
        market_data_source = str(payload.get("marketDataSource") or "").strip().lower()
        if broker != "capital" and market_data_source != "capital":
            return None

        bars = parse_recent_bars(payload, limit=40)
        if not bars:
            current_bar = normalize_bar(payload.get("currentBar"))
            if current_bar["close"] > 0:
                bars = [current_bar]
        if len(bars) < 3:
            return None

        closes = [bar["close"] for bar in bars if bar["close"] > 0]
        volumes = [bar["volume"] for bar in bars]
        if len(closes) < 3:
            return None

        fast_window = min(5, len(closes))
        slow_window = min(20, len(closes))
        fast_ma = sum(closes[-fast_window:]) / float(fast_window)
        slow_ma = sum(closes[-slow_window:]) / float(slow_window)
        last_close = closes[-1]
        prev_close = closes[-2]
        momentum = (last_close - prev_close) / prev_close if prev_close else 0.0
        trend = (fast_ma - slow_ma) / slow_ma if slow_ma else 0.0
        avg_vol = sum(volumes) / float(len(volumes)) if volumes else 0.0
        last_vol = volumes[-1] if volumes else 0.0
        vol_boost = min(1.0, last_vol / avg_vol) if avg_vol > 0 else 0.5

        signal = "HOLD"
        if trend > 0.001 and momentum > 0:
            signal = "BUY"
        elif trend < -0.001 and momentum < 0:
            signal = "SELL"

        confidence = min(0.9, 0.55 + abs(trend) * 30.0 + abs(momentum) * 25.0 + vol_boost * 0.1)
        if signal == "HOLD":
            confidence = min(confidence, 0.65)

        reason = (
            "Capital futures context decision: "
            f"signal={signal}, close={last_close:.2f}, trend={trend:.4%}, momentum={momentum:.4%}, "
            f"bars={len(closes)}"
        )
        raw_decision = {
            "mode": "capital_context",
            "instrument": payload.get("instrument"),
            "broker": broker or market_data_source,
            "barCount": len(closes),
            "lastClose": last_close,
            "fastMA": fast_ma,
            "slowMA": slow_ma,
            "trend": trend,
            "momentum": momentum,
            "volumeRatio": vol_boost,
            "fallbackTicker": payload.get("fallbackTicker"),
        }
        return build_signal(
            config=self.config,
            ticker=ticker,
            trade_date=trade_date,
            source="capital_context",
            signal=signal,
            confidence=confidence,
            reason=reason,
            raw_decision=raw_decision,
        )

    def _decision_to_signal(self, ticker: str, trade_date: str, decision: Any) -> dict[str, Any]:
        if isinstance(decision, str):
            return build_signal(
                config=self.config,
                ticker=ticker,
                trade_date=trade_date,
                source="tradingagents",
                signal=decision,
                confidence=0.6,
                reason=f"TradingAgents decision: {decision}",
                raw_decision=decision,
            )
        if isinstance(decision, dict):
            signal = decision.get("signal") or decision.get("action") or decision.get("decision") or "HOLD"
            return build_signal(
                config=self.config,
                ticker=ticker,
                trade_date=trade_date,
                source="tradingagents",
                signal=signal,
                confidence=float(decision.get("confidence") or 0.6),
                reason=str(decision.get("reason") or decision.get("rationale") or "TradingAgents decision."),
                raw_decision=decision,
            )
        return build_signal(
            config=self.config,
            ticker=ticker,
            trade_date=trade_date,
            source="tradingagents_unknown",
            reason="TradingAgents returned an unknown decision format.",
            raw_decision=repr(decision),
        )


class RequestHandler(BaseHTTPRequestHandler):
    service: TradingAgentsService | None = None

    def do_GET(self) -> None:
        if self.path == "/health":
            self._respond(200, self.service.health())
            return
        self._respond(404, {"error": "not_found"})

    def do_POST(self) -> None:
        if self.path != "/analyze":
            self._respond(404, {"error": "not_found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length).decode("utf-8") if length else "{}"
            payload = json.loads(raw)
            self._respond(200, self.service.analyze(payload))
        except Exception as exc:
            self._respond(500, {"error": str(exc), "signal": "HOLD", "noOrderWrite": True})

    def _respond(self, code: int, data: dict[str, Any]) -> None:
        body = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args: Any) -> None:
        return


def write_state(payload: dict[str, Any]) -> None:
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def make_config(args: argparse.Namespace) -> BridgeConfig:
    provider = args.provider.lower().strip()
    if provider == "simulated":
        llm_provider = args.llm_provider or "simulated"
    else:
        llm_provider = args.llm_provider or provider
        provider = "tradingagents"
    return BridgeConfig(
        host=args.host,
        port=args.port,
        provider=provider,
        llm_provider=llm_provider,
        model=args.model,
        quick_model=args.quick_model or args.model,
        max_debate=args.max_debate,
        output_language=args.output_language,
        strict_upstream=args.strict_upstream,
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="OpenClaw TradingAgents bridge")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8390)
    parser.add_argument("--provider", default="simulated", help="simulated, or a TradingAgents llm_provider")
    parser.add_argument("--llm-provider", default=None)
    parser.add_argument("--model", default="gpt-5.4-mini")
    parser.add_argument("--quick-model", default=None)
    parser.add_argument("--max-debate", type=int, default=1)
    parser.add_argument("--output-language", default="Chinese")
    parser.add_argument("--strict-upstream", action="store_true")
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--no-write-state", action="store_true")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    config = make_config(args)
    service = TradingAgentsService(config)
    RequestHandler.service = service

    if args.self_test:
        result = {
            "schema": "openclaw.tradingagents.integration.self-test.v1",
            "generatedAt": utc_now(),
            "health": service.health(),
            "sampleSignal": service.analyze({"ticker": "NVDA", "trade_date": "2026-01-15"}),
            "no_live_order_sent": True,
        }
        if not args.no_write_state:
            write_state(result)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    server = HTTPServer((config.host, config.port), RequestHandler)
    print(json.dumps(service.health(), ensure_ascii=False))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

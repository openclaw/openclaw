from __future__ import annotations

import csv
import math
import statistics
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any


def _clip(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def _safe_mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _safe_std(values: list[float]) -> float:
    if len(values) < 2:
        return 0.0
    return statistics.pstdev(values)


def _rolling_window(values: list[float], idx: int, window: int) -> list[float]:
    start = max(0, idx - window + 1)
    return values[start : idx + 1]


def _to_float(raw: str) -> float:
    value = float(raw)
    if not math.isfinite(value):
        raise ValueError("non-finite numeric value")
    return value


@dataclass
class TrinityParams:
    symbol: str
    max_position: float = 0.20
    base_risk: float = 0.50
    allow_short: bool = False
    fee_bps: float = 1.0
    slippage_bps: float = 2.0
    max_turnover_per_bar: float = 0.10
    volatility_soft_cap: float = 0.025
    volatility_hard_cap: float = 0.050
    drawdown_soft_cap: float = 0.10
    min_trade_delta: float = 0.01

    def validate(self) -> None:
        if self.max_position <= 0 or self.max_position > 1:
            raise ValueError("max_position must be in (0, 1]")
        if self.base_risk <= 0 or self.base_risk > 1:
            raise ValueError("base_risk must be in (0, 1]")
        if self.max_turnover_per_bar <= 0 or self.max_turnover_per_bar > 1:
            raise ValueError("max_turnover_per_bar must be in (0, 1]")
        if self.fee_bps < 0 or self.slippage_bps < 0:
            raise ValueError("fee/slippage bps must be >= 0")


def load_price_rows(csv_path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with csv_path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise ValueError("CSV header missing")
        normalized = {name.lower(): name for name in reader.fieldnames}
        if "close" not in normalized:
            raise ValueError("CSV must include 'close' column")
        date_key = "date"
        if "date" not in normalized:
            date_key = "timestamp" if "timestamp" in normalized else ""

        for idx, raw_row in enumerate(reader):
            close = _to_float(raw_row[normalized["close"]])
            if close <= 0:
                raise ValueError("close must be positive")

            date_value = raw_row[normalized[date_key]] if date_key else str(idx)
            rows.append(
                {
                    "idx": idx,
                    "date": date_value,
                    "close": close,
                }
            )

    if len(rows) < 80:
        raise ValueError("at least 80 rows required for stable backtest")
    return rows


def _alpha_signal(closes: list[float], idx: int) -> tuple[float, float]:
    w5 = _rolling_window(closes, idx, 5)
    w20 = _rolling_window(closes, idx, 20)
    w55 = _rolling_window(closes, idx, 55)
    w10 = _rolling_window(closes, idx, 10)

    p = closes[idx]
    m5 = _safe_mean(w5)
    m20 = _safe_mean(w20)
    m10 = _safe_mean(w10)
    s10 = _safe_std(w10)

    mom_fast = (p / m5 - 1.0) if m5 > 0 else 0.0
    mom_slow = (p / m20 - 1.0) if m20 > 0 else 0.0
    zscore = (p - m10) / s10 if s10 > 1e-12 else 0.0
    if w55:
        low_55 = min(w55)
        high_55 = max(w55)
        range_55 = max(high_55 - low_55, 1e-12)
        breakout = ((p - low_55) / range_55) * 2.0 - 1.0
    else:
        breakout = 0.0

    trend_strength = mom_fast * 0.6 + mom_slow * 0.4
    alpha = 1.20 * trend_strength + 0.35 * breakout - 0.08 * zscore
    alpha = _clip(alpha * 6.0, -1.0, 1.0)
    confidence = _clip(abs(trend_strength) * 12.0 + abs(breakout) * 0.35, 0.0, 1.0)
    return alpha, confidence


def _policy_target(
    alpha: float,
    confidence: float,
    volatility: float,
    drawdown: float,
    current_position: float,
    params: TrinityParams,
) -> tuple[float, list[str]]:
    flags: list[str] = []
    risk_multiplier = 1.0

    if volatility > params.volatility_soft_cap:
        risk_multiplier *= 0.6
        flags.append("volatility_soft_cap")
    if volatility > params.volatility_hard_cap:
        risk_multiplier *= 0.0
        flags.append("volatility_hard_cap")
    if abs(drawdown) > params.drawdown_soft_cap:
        risk_multiplier *= 0.5
        flags.append("drawdown_soft_cap")

    effective_confidence = max(confidence, 0.25)
    raw = alpha * effective_confidence * params.base_risk * risk_multiplier
    target = _clip(raw, -params.max_position, params.max_position)
    if not params.allow_short:
        target = max(0.0, target)

    if abs(target - current_position) < params.min_trade_delta:
        target = current_position
        flags.append("trade_suppressed")

    return target, flags


def _max_drawdown(equity_curve: list[float]) -> float:
    peak = equity_curve[0]
    max_dd = 0.0
    for equity in equity_curve:
        peak = max(peak, equity)
        dd = equity / peak - 1.0
        max_dd = min(max_dd, dd)
    return max_dd


def _annualized_return(equity_end: float, bars: int, bars_per_year: int = 252) -> float:
    if bars <= 1 or equity_end <= 0:
        return 0.0
    years = bars / bars_per_year
    if years <= 0:
        return 0.0
    return equity_end ** (1.0 / years) - 1.0


def run_trinity_backtest(rows: list[dict[str, Any]], params: TrinityParams) -> dict[str, Any]:
    params.validate()
    closes = [float(row["close"]) for row in rows]
    dates = [str(row["date"]) for row in rows]
    if len(closes) < 80:
        raise ValueError("at least 80 rows required for stable backtest")

    equity = 1.0
    position = 0.0
    equity_curve = [equity]
    bar_returns: list[float] = []
    turnover_total = 0.0
    trade_count = 0

    signal_rows: list[dict[str, Any]] = []
    trade_rows: list[dict[str, Any]] = []

    fee_rate = params.fee_bps / 10000.0
    slippage_rate = params.slippage_bps / 10000.0

    for i in range(1, len(closes)):
        px_now = closes[i]
        px_prev = closes[i - 1]
        market_return = px_now / px_prev - 1.0

        alpha, confidence = _alpha_signal(closes, i)
        recent_rets = [
            closes[j] / closes[j - 1] - 1.0 for j in range(max(1, i - 20), i + 1)
        ]
        volatility = _safe_std(recent_rets)
        drawdown = _max_drawdown(equity_curve)
        target, flags = _policy_target(
            alpha=alpha,
            confidence=confidence,
            volatility=volatility,
            drawdown=drawdown,
            current_position=position,
            params=params,
        )

        desired_delta = target - position
        executed_delta = _clip(
            desired_delta, -params.max_turnover_per_bar, params.max_turnover_per_bar
        )
        filled_position = _clip(
            position + executed_delta, -params.max_position, params.max_position
        )
        if not params.allow_short:
            filled_position = max(0.0, filled_position)

        abs_trade = abs(filled_position - position)
        turnover_total += abs_trade
        if abs_trade > 1e-12:
            trade_count += 1

        transaction_cost = abs_trade * (fee_rate + slippage_rate)
        net_return = position * market_return - transaction_cost
        equity *= 1.0 + net_return
        equity_curve.append(equity)
        bar_returns.append(net_return)

        signal_rows.append(
            {
                "date": dates[i],
                "alpha_score": round(alpha, 8),
                "confidence": round(confidence, 8),
                "volatility": round(volatility, 8),
                "target_position": round(target, 8),
                "filled_position": round(filled_position, 8),
                "flags": "|".join(flags),
            }
        )
        if abs_trade > 1e-12:
            trade_rows.append(
                {
                    "date": dates[i],
                    "from_position": round(position, 8),
                    "to_position": round(filled_position, 8),
                    "delta": round(filled_position - position, 8),
                    "cost": round(transaction_cost, 10),
                    "market_return": round(market_return, 8),
                }
            )

        position = filled_position

    sharpe_denom = _safe_std(bar_returns)
    sharpe = (math.sqrt(252.0) * _safe_mean(bar_returns) / sharpe_denom) if sharpe_denom > 1e-12 else 0.0
    max_dd = _max_drawdown(equity_curve)
    win_rate = (
        sum(1 for value in bar_returns if value > 0) / len(bar_returns)
        if bar_returns
        else 0.0
    )

    metrics = {
        "symbol": params.symbol,
        "bars": len(rows),
        "start_date": dates[0],
        "end_date": dates[-1],
        "total_return": equity - 1.0,
        "cagr": _annualized_return(equity, len(rows)),
        "sharpe": sharpe,
        "max_drawdown": max_dd,
        "win_rate": win_rate,
        "turnover": turnover_total,
        "trade_count": trade_count,
        "defaults": {
            "max_position": params.max_position,
            "base_risk": params.base_risk,
            "allow_short": params.allow_short,
            "fee_bps": params.fee_bps,
            "slippage_bps": params.slippage_bps,
            "max_turnover_per_bar": params.max_turnover_per_bar,
            "volatility_soft_cap": params.volatility_soft_cap,
            "volatility_hard_cap": params.volatility_hard_cap,
            "drawdown_soft_cap": params.drawdown_soft_cap,
            "min_trade_delta": params.min_trade_delta,
        },
        "guardrails": {
            "position_cap": True,
            "turnover_cap": True,
            "drawdown_throttle": True,
            "volatility_throttle": True,
        },
    }

    return {
        "metrics": metrics,
        "equity_curve": equity_curve,
        "signal_rows": signal_rows,
        "trade_rows": trade_rows,
    }


def run_parameter_sweep(rows: list[dict[str, Any]], symbol: str) -> dict[str, Any]:
    candidates: list[dict[str, Any]] = []
    for max_position in (0.10, 0.15, 0.20, 0.25):
        for base_risk in (0.20, 0.30, 0.40):
            for max_turnover in (0.05, 0.10, 0.15):
                params = TrinityParams(
                    symbol=symbol,
                    max_position=max_position,
                    base_risk=base_risk,
                    max_turnover_per_bar=max_turnover,
                )
                result = run_trinity_backtest(rows, params)
                metrics = result["metrics"]
                score = (
                    2.0 * metrics["cagr"]
                    + 1.0 * metrics["sharpe"]
                    - 3.0 * abs(metrics["max_drawdown"])
                    - 0.05 * metrics["turnover"]
                )
                candidates.append(
                    {
                        "max_position": max_position,
                        "base_risk": base_risk,
                        "max_turnover_per_bar": max_turnover,
                        "score": score,
                        "cagr": metrics["cagr"],
                        "sharpe": metrics["sharpe"],
                        "max_drawdown": metrics["max_drawdown"],
                        "turnover": metrics["turnover"],
                        "trade_count": metrics["trade_count"],
                    }
                )

    candidates.sort(key=lambda row: row["score"], reverse=True)
    return {
        "best": candidates[0],
        "candidates": candidates,
    }


def iso_timestamp() -> str:
    return datetime.utcnow().replace(microsecond=0).isoformat() + "Z"

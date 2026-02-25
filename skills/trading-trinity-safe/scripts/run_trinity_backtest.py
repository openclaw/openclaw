from __future__ import annotations

import argparse
import csv
import json
import os
from pathlib import Path
from typing import Any

from trinity_engine import (
    TrinityParams,
    iso_timestamp,
    load_price_rows,
    run_parameter_sweep,
    run_trinity_backtest,
)


def _write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    if not rows:
        path.write_text("", encoding="utf-8")
        return
    fieldnames = list(rows[0].keys())
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)


def _write_equity_csv(path: Path, equity_curve: list[float]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["bar_index", "equity"])
        for idx, equity in enumerate(equity_curve):
            writer.writerow([idx, f"{equity:.10f}"])


def _verdict(metrics: dict[str, Any]) -> tuple[str, list[str]]:
    reasons: list[str] = []
    verdict = "PASS"
    if metrics["trade_count"] < 5:
        verdict = "PASS_WITH_WARNINGS"
        reasons.append("low_trade_count")
    if metrics["max_drawdown"] < -0.25:
        verdict = "PASS_WITH_WARNINGS"
        reasons.append("drawdown_above_threshold")
    if metrics["total_return"] < 0:
        verdict = "PASS_WITH_WARNINGS"
        reasons.append("negative_total_return")
    return verdict, reasons


def _summary_text(metrics: dict[str, Any], verdict: str, warnings: list[str]) -> str:
    return "\n".join(
        [
            f"verdict={verdict}",
            f"symbol={metrics['symbol']}",
            f"bars={metrics['bars']}",
            f"period={metrics['start_date']}..{metrics['end_date']}",
            f"total_return={metrics['total_return']:.6f}",
            f"cagr={metrics['cagr']:.6f}",
            f"sharpe={metrics['sharpe']:.6f}",
            f"max_drawdown={metrics['max_drawdown']:.6f}",
            f"win_rate={metrics['win_rate']:.6f}",
            f"turnover={metrics['turnover']:.6f}",
            f"trade_count={metrics['trade_count']}",
            f"warnings={','.join(warnings) if warnings else 'none'}",
        ]
    )


def main() -> int:
    default_out_dir = os.environ.get(
        "TRINITY_EXPORT_DIR", str(Path.cwd() / "outputs" / "trading-trinity")
    )
    parser = argparse.ArgumentParser(
        description="Run a safe tri-layer trading backtest (research -> policy -> execution)."
    )
    parser.add_argument("--csv", required=True, help="Input OHLCV CSV (date + close required)")
    parser.add_argument("--symbol", default="SPY", help="Symbol label for reporting")
    parser.add_argument(
        "--out-dir",
        default=default_out_dir,
        help="Output directory",
    )
    parser.add_argument("--mode", choices=("backtest", "sweep"), default="backtest")

    parser.add_argument("--max-position", type=float, default=0.20)
    parser.add_argument("--base-risk", type=float, default=0.50)
    parser.add_argument("--allow-short", action="store_true")
    parser.add_argument("--fee-bps", type=float, default=1.0)
    parser.add_argument("--slippage-bps", type=float, default=2.0)
    parser.add_argument("--max-turnover-per-bar", type=float, default=0.10)
    parser.add_argument("--volatility-soft-cap", type=float, default=0.025)
    parser.add_argument("--volatility-hard-cap", type=float, default=0.050)
    parser.add_argument("--drawdown-soft-cap", type=float, default=0.10)
    parser.add_argument("--min-trade-delta", type=float, default=0.01)
    args = parser.parse_args()

    csv_path = Path(args.csv).expanduser().resolve()
    out_dir = Path(args.out_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    rows = load_price_rows(csv_path)

    if args.mode == "sweep":
        sweep_result = run_parameter_sweep(rows=rows, symbol=args.symbol)
        sweep_path = out_dir / "sweep.csv"
        _write_csv(sweep_path, sweep_result["candidates"])
        print(json.dumps({"status": "ok", "mode": "sweep", "best": sweep_result["best"], "sweep_csv": str(sweep_path)}, indent=2))
        return 0

    params = TrinityParams(
        symbol=args.symbol,
        max_position=args.max_position,
        base_risk=args.base_risk,
        allow_short=args.allow_short,
        fee_bps=args.fee_bps,
        slippage_bps=args.slippage_bps,
        max_turnover_per_bar=args.max_turnover_per_bar,
        volatility_soft_cap=args.volatility_soft_cap,
        volatility_hard_cap=args.volatility_hard_cap,
        drawdown_soft_cap=args.drawdown_soft_cap,
        min_trade_delta=args.min_trade_delta,
    )
    result = run_trinity_backtest(rows=rows, params=params)
    metrics = result["metrics"]
    verdict, warnings = _verdict(metrics)

    metrics_with_meta = dict(metrics)
    metrics_with_meta["verdict"] = verdict
    metrics_with_meta["warnings"] = warnings
    metrics_with_meta["generated_at"] = iso_timestamp()
    metrics_with_meta["input_csv"] = str(csv_path)

    metrics_path = out_dir / "metrics.json"
    summary_path = out_dir / "summary.txt"
    trades_path = out_dir / "trades.csv"
    signals_path = out_dir / "signals.csv"
    equity_path = out_dir / "equity.csv"

    metrics_path.write_text(json.dumps(metrics_with_meta, indent=2), encoding="utf-8")
    summary_path.write_text(
        _summary_text(metrics=metrics, verdict=verdict, warnings=warnings) + "\n",
        encoding="utf-8",
    )
    _write_csv(trades_path, result["trade_rows"])
    _write_csv(signals_path, result["signal_rows"])
    _write_equity_csv(equity_path, result["equity_curve"])

    print(
        json.dumps(
            {
                "status": "ok",
                "mode": "backtest",
                "verdict": verdict,
                "warnings": warnings,
                "metrics": metrics,
                "artifacts": {
                    "metrics_json": str(metrics_path),
                    "summary_txt": str(summary_path),
                    "trades_csv": str(trades_path),
                    "signals_csv": str(signals_path),
                    "equity_csv": str(equity_path),
                },
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

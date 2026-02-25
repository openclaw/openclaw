from __future__ import annotations

import csv
import math
import tempfile
import unittest
from pathlib import Path

from trinity_engine import TrinityParams, load_price_rows, run_parameter_sweep, run_trinity_backtest


def _write_synthetic_csv(path: Path, bars: int = 180) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["date", "close"])
        price = 100.0
        for i in range(bars):
            # Deterministic trend + cyclical noise; no randomness.
            cycle = math.sin(i / 9.0) * 0.004
            trend = 0.0006
            price *= 1.0 + trend + cycle
            writer.writerow([f"2024-01-{(i % 28) + 1:02d}", f"{price:.8f}"])


class TrinityEngineTests(unittest.TestCase):
    def test_backtest_runs_and_respects_position_cap(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = Path(tmp) / "synthetic.csv"
            _write_synthetic_csv(csv_path)
            rows = load_price_rows(csv_path)
            params = TrinityParams(symbol="TEST", max_position=0.18, allow_short=False)
            result = run_trinity_backtest(rows, params)

            metrics = result["metrics"]
            self.assertIn("cagr", metrics)
            self.assertIn("sharpe", metrics)
            self.assertGreaterEqual(metrics["trade_count"], 0)

            for row in result["signal_rows"]:
                self.assertGreaterEqual(row["filled_position"], 0.0)
                self.assertLessEqual(row["filled_position"], 0.18 + 1e-9)

    def test_parameter_sweep_returns_ranked_candidates(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            csv_path = Path(tmp) / "synthetic.csv"
            _write_synthetic_csv(csv_path)
            rows = load_price_rows(csv_path)
            sweep = run_parameter_sweep(rows=rows, symbol="TEST")
            self.assertIn("best", sweep)
            self.assertIn("candidates", sweep)
            self.assertGreater(len(sweep["candidates"]), 1)
            self.assertGreaterEqual(
                sweep["candidates"][0]["score"], sweep["candidates"][-1]["score"]
            )


if __name__ == "__main__":
    unittest.main()


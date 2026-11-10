#!/usr/bin/env python3
"""
Tests for model_usage helpers.
"""

import argparse
import io
import json
from datetime import date, timedelta
from unittest import TestCase, main
from unittest.mock import patch

from model_usage import (
    aggregate_costs,
    coerce_finite_cost,
    filter_by_days,
    latest_day_cost,
    load_payload,
    main as model_usage_main,
    pick_current_model,
    positive_int,
)


class TestModelUsage(TestCase):
    def test_live_cli_preserves_requested_and_default_reporting_windows(self):
        for provider in ("codex", "claude"):
            for days in (None, 60):
                with self.subTest(provider=provider, days=days):
                    payload = [{"provider": provider, "daily": [{
                        "date": date.today().isoformat(),
                        "modelBreakdowns": [{"modelName": "fixture-model", "cost": 1.0}],
                    }]}]
                    argv = ["model_usage.py", "--provider", provider,
                            "--mode", "all", "--format", "json"]
                    expected = ["codexbar", "cost", "--format", "json",
                                "--provider", provider]
                    if days is not None:
                        argv += ["--days", str(days)]
                        expected += ["--days", str(days)]
                    with patch("sys.argv", argv), patch("sys.stdout", io.StringIO()) as stdout:
                        with patch("model_usage.subprocess.check_output",
                                   return_value=json.dumps(payload)) as fetch:
                            self.assertEqual(model_usage_main(), 0)
                    fetch.assert_called_once_with(expected, text=True)
                    self.assertEqual(json.loads(stdout.getvalue())["models"],
                                     [{"model": "fixture-model", "totalCostUSD": 1.0}])

    def test_load_payload_rejects_mismatched_provider_object(self):
        with patch("sys.stdin", io.StringIO('{"provider":"claude","daily":[]}')):
            with self.assertRaisesRegex(
                RuntimeError, "^Provider 'codex' not found in codexbar payload\\.$"
            ):
                load_payload("-", "codex")

    def test_positive_int_accepts_valid_numbers(self):
        self.assertEqual(positive_int("1"), 1)
        self.assertEqual(positive_int("7"), 7)

    def test_positive_int_rejects_zero_and_negative(self):
        with self.assertRaises(argparse.ArgumentTypeError):
            positive_int("0")
        with self.assertRaises(argparse.ArgumentTypeError):
            positive_int("-3")

    def test_filter_by_days_keeps_recent_entries(self):
        today = date.today()
        entries = [
            {"date": (today - timedelta(days=5)).strftime("%Y-%m-%d"), "modelBreakdowns": []},
            {"date": (today - timedelta(days=1)).strftime("%Y-%m-%d"), "modelBreakdowns": []},
            {"date": today.strftime("%Y-%m-%d"), "modelBreakdowns": []},
        ]

        filtered = filter_by_days(entries, 2)

        self.assertEqual(len(filtered), 2)
        self.assertEqual(filtered[0]["date"], (today - timedelta(days=1)).strftime("%Y-%m-%d"))
        self.assertEqual(filtered[1]["date"], today.strftime("%Y-%m-%d"))

    def test_coerce_finite_cost_accepts_numbers_and_numeric_strings(self):
        self.assertEqual(coerce_finite_cost(2), 2.0)
        self.assertEqual(coerce_finite_cost(1.75), 1.75)
        self.assertEqual(coerce_finite_cost("1.75"), 1.75)
        self.assertEqual(coerce_finite_cost("  2.5 "), 2.5)

    def test_coerce_finite_cost_rejects_unusable_values(self):
        # Booleans are ints in Python, but never valid costs.
        for value in (True, False, float("nan"), float("inf"), float("-inf"),
                      "NaN", "Infinity", "not-a-number", "", None, {}):
            with self.subTest(value=value):
                self.assertIsNone(coerce_finite_cost(value))

    def test_aggregate_costs_ignores_bool_and_non_finite(self):
        entries = [
            {
                "date": "2026-05-25",
                "modelBreakdowns": [
                    {"modelName": "claude-sonnet-4-6", "cost": 1.50},
                    {"modelName": "claude-sonnet-4-6", "cost": "1.75"},
                    {"modelName": "claude-sonnet-4-6", "cost": True},
                    {"modelName": "claude-sonnet-4-6", "cost": float("nan")},
                    {"modelName": "claude-sonnet-4-6", "cost": float("inf")},
                ],
            }
        ]
        totals = aggregate_costs(entries)
        # NaN/Infinity must not poison the total; bool must not add 1.0.
        self.assertEqual(totals, {"claude-sonnet-4-6": 3.25})

    def test_pick_current_model_scores_numeric_string_costs(self):
        # model-b's cost is a numeric string; it must still win on highest cost.
        entries = [
            {
                "date": "2026-05-25",
                "modelBreakdowns": [
                    {"modelName": "model-a", "cost": 1.0},
                    {"modelName": "model-b", "cost": "5.0"},
                ],
            }
        ]
        model, day = pick_current_model(entries)
        self.assertEqual(model, "model-b")
        self.assertEqual(day, "2026-05-25")

    def test_pick_current_model_ignores_bool_and_non_finite(self):
        # Only model-a has a usable cost; bool and NaN must not be scored.
        entries = [
            {
                "date": "2026-05-25",
                "modelBreakdowns": [
                    {"modelName": "model-a", "cost": 2.0},
                    {"modelName": "model-b", "cost": True},
                    {"modelName": "model-c", "cost": float("nan")},
                ],
            }
        ]
        model, _day = pick_current_model(entries)
        self.assertEqual(model, "model-a")

    def test_latest_day_cost_accepts_numeric_string(self):
        entries = [
            {
                "date": "2026-05-25",
                "modelBreakdowns": [{"modelName": "model-a", "cost": "2.50"}],
            }
        ]
        day, cost = latest_day_cost(entries, "model-a")
        self.assertEqual(day, "2026-05-25")
        self.assertEqual(cost, 2.50)

    def test_latest_day_cost_rejects_non_finite(self):
        entries = [
            {
                "date": "2026-05-25",
                "modelBreakdowns": [{"modelName": "model-a", "cost": float("inf")}],
            }
        ]
        day, cost = latest_day_cost(entries, "model-a")
        self.assertEqual(day, "2026-05-25")
        self.assertIsNone(cost)


if __name__ == "__main__":
    main()

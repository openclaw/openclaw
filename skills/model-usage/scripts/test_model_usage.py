#!/usr/bin/env python3
"""
Tests for model_usage helpers.
"""

import argparse
import io
import json
import sys
import tempfile
from contextlib import redirect_stderr, redirect_stdout
from datetime import date, timedelta
from pathlib import Path
from unittest import TestCase, main
from unittest.mock import patch

from model_usage import (
    filter_by_days,
    latest_model_date,
    model_seen,
    positive_int,
)
from model_usage import (
    main as model_usage_main,
)


class TestModelUsage(TestCase):
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

    def test_latest_model_date_prefers_latest_occurrence(self):
        today = date.today()
        entries = [
            {
                "date": (today - timedelta(days=2)).strftime("%Y-%m-%d"),
                "modelBreakdowns": [{"modelName": "gpt-5", "cost": 1.0}],
            },
            {
                "date": (today - timedelta(days=1)).strftime("%Y-%m-%d"),
                "modelsUsed": ["gpt-4.1", "gpt-5"],
            },
            {
                "date": today.strftime("%Y-%m-%d"),
                "modelBreakdowns": [{"modelName": "gpt-4.1", "cost": 0.4}],
            },
        ]

        self.assertEqual(latest_model_date(entries, "gpt-5"), (today - timedelta(days=1)).strftime("%Y-%m-%d"))

    def test_latest_model_date_returns_none_for_missing_model(self):
        today = date.today()
        entries = [
            {
                "date": today.strftime("%Y-%m-%d"),
                "modelBreakdowns": [{"modelName": "gpt-4.1", "cost": 0.4}],
            }
        ]

        self.assertIsNone(latest_model_date(entries, "gpt-5"))

    def test_model_seen_detects_models_used_and_undated_entries(self):
        entries = [
            {"modelsUsed": ["gpt-5"]},
            {"modelBreakdowns": [{"modelName": "gpt-4.1", "cost": 0.1}]},
        ]

        self.assertTrue(model_seen(entries, "gpt-5"))
        self.assertFalse(model_seen(entries, "claude-3"))

    def _run_main_with_payload(self, payload, extra_args):
        with tempfile.TemporaryDirectory(prefix="model_usage_test_") as tmp:
            input_path = Path(tmp) / "payload.json"
            input_path.write_text(json.dumps(payload), encoding="utf-8")

            argv = [
                "model_usage.py",
                "--provider",
                "codex",
                "--mode",
                "current",
                "--input",
                str(input_path),
                *extra_args,
            ]
            stdout = io.StringIO()
            stderr = io.StringIO()
            with patch.object(sys, "argv", argv):
                with redirect_stdout(stdout), redirect_stderr(stderr):
                    code = model_usage_main()
            return code, stdout.getvalue(), stderr.getvalue()

    def test_main_explicit_model_reports_days_filter_miss(self):
        payload = {
            "provider": "codex",
            "daily": [
                {
                    "date": "2020-01-01",
                    "modelBreakdowns": [{"modelName": "gpt-5", "cost": 1.0}],
                }
            ],
        }

        code, _out, err = self._run_main_with_payload(payload, ["--model", "gpt-5", "--days", "1"])

        self.assertEqual(code, 2)
        self.assertIn("not found in last 1 day(s)", err)

    def test_main_explicit_model_without_breakdowns_fails_cleanly(self):
        today = date.today().strftime("%Y-%m-%d")
        payload = {
            "provider": "codex",
            "daily": [
                {
                    "date": today,
                    "modelsUsed": ["gpt-5"],
                }
            ],
        }

        code, _out, err = self._run_main_with_payload(payload, ["--model", "gpt-5"])

        self.assertEqual(code, 2)
        self.assertIn("has no model breakdown costs", err)

    def test_main_explicit_model_without_date_is_not_treated_as_missing(self):
        payload = {
            "provider": "codex",
            "daily": [
                {
                    "modelBreakdowns": [{"modelName": "gpt-5", "cost": 1.0}],
                }
            ],
        }

        code, out, err = self._run_main_with_payload(payload, ["--model", "gpt-5"])

        self.assertEqual(code, 0)
        self.assertIn("Current model: gpt-5", out)
        self.assertIn("Total cost (rows): $1.00", out)
        self.assertEqual(err, "")


if __name__ == "__main__":
    main()

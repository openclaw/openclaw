#!/usr/bin/env python3
"""
Tests for model_usage helpers.
"""

import argparse
import json
import shutil
import tempfile
from datetime import date, timedelta
from pathlib import Path
from unittest import TestCase, main

from model_usage import filter_by_days, load_payload, positive_int


class TestModelUsage(TestCase):
    def setUp(self):
        self.temp_dir = Path(tempfile.mkdtemp(prefix="model_usage_tests_"))

    def tearDown(self):
        if self.temp_dir.exists():
            shutil.rmtree(self.temp_dir)

    def write_payload(self, name: str, payload):
        path = self.temp_dir / name
        path.write_text(json.dumps(payload), encoding="utf-8")
        return str(path)

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

    def test_load_payload_rejects_provider_mismatch_for_single_payload(self):
        input_path = self.write_payload("single.json", {"provider": "claude", "daily": []})

        with self.assertRaisesRegex(RuntimeError, "does not match requested provider"):
            load_payload(input_path, "codex")

    def test_load_payload_matches_provider_case_insensitively_from_list(self):
        input_path = self.write_payload(
            "list.json",
            [
                {"provider": "CLAUDE", "daily": [{"date": "2026-03-05"}]},
                {"provider": "CODEX", "daily": [{"date": "2026-03-06"}]},
            ],
        )

        payload = load_payload(input_path, "codex")

        self.assertEqual(payload.get("provider"), "CODEX")
        self.assertEqual(payload.get("daily"), [{"date": "2026-03-06"}])


if __name__ == "__main__":
    main()

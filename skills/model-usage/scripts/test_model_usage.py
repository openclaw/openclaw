#!/usr/bin/env python3
"""
Tests for model_usage helpers.
"""

import argparse
from datetime import date, timedelta
from unittest import TestCase, main

from model_usage import filter_by_days, latest_model_date, positive_int


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


if __name__ == "__main__":
    main()

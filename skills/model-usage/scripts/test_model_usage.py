#!/usr/bin/env python3
"""
Tests for model_usage helpers.
"""

import argparse
from datetime import date, timedelta
from unittest import TestCase, main

from model_usage import aggregate_costs, filter_by_days, latest_day_cost, positive_int


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

    def test_aggregate_costs_accepts_numeric_strings_and_skips_non_finite_values(self):
        entries = [
            {
                "modelBreakdowns": [
                    {"modelName": "gpt-5", "cost": "1.25"},
                    {"modelName": "gpt-5", "cost": "nan"},
                    {"modelName": "gpt-5", "cost": True},
                    {"modelName": "gpt-5-mini", "cost": 0.75},
                ]
            }
        ]

        totals = aggregate_costs(entries)

        self.assertEqual(totals["gpt-5"], 1.25)
        self.assertEqual(totals["gpt-5-mini"], 0.75)

    def test_latest_day_cost_parses_numeric_string(self):
        entries = [
            {"date": "2026-03-04", "modelBreakdowns": [{"modelName": "gpt-5", "cost": 0.5}]},
            {"date": "2026-03-05", "modelBreakdowns": [{"modelName": "gpt-5", "cost": "1.75"}]},
        ]

        latest_date, latest_cost = latest_day_cost(entries, "gpt-5")

        self.assertEqual(latest_date, "2026-03-05")
        self.assertEqual(latest_cost, 1.75)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Tests for model_usage helpers.
"""

import argparse
from datetime import date, timedelta
from unittest import TestCase, main

from model_usage import aggregate_costs, coerce_finite_cost, filter_by_days, positive_int


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

    def test_coerce_finite_cost_accepts_numbers_and_numeric_strings(self):
        self.assertEqual(coerce_finite_cost(2), 2.0)
        self.assertEqual(coerce_finite_cost(1.75), 1.75)
        self.assertEqual(coerce_finite_cost("1.75"), 1.75)
        self.assertEqual(coerce_finite_cost("  2.5 "), 2.5)

    def test_coerce_finite_cost_rejects_booleans(self):
        # bool is a subclass of int in Python, but is never a valid cost.
        self.assertIsNone(coerce_finite_cost(True))
        self.assertIsNone(coerce_finite_cost(False))

    def test_coerce_finite_cost_rejects_non_finite(self):
        self.assertIsNone(coerce_finite_cost(float("nan")))
        self.assertIsNone(coerce_finite_cost(float("inf")))
        self.assertIsNone(coerce_finite_cost(float("-inf")))
        self.assertIsNone(coerce_finite_cost("NaN"))
        self.assertIsNone(coerce_finite_cost("Infinity"))

    def test_coerce_finite_cost_rejects_unusable_values(self):
        self.assertIsNone(coerce_finite_cost("not-a-number"))
        self.assertIsNone(coerce_finite_cost(""))
        self.assertIsNone(coerce_finite_cost(None))
        self.assertIsNone(coerce_finite_cost({}))

    def test_aggregate_costs_includes_numeric_strings(self):
        entries = [
            {
                "date": "2026-05-25",
                "modelBreakdowns": [
                    {"modelName": "claude-sonnet-4-6", "cost": 1.50},
                    {"modelName": "claude-sonnet-4-6", "cost": "1.75"},
                ],
            }
        ]
        self.assertEqual(aggregate_costs(entries), {"claude-sonnet-4-6": 3.25})

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


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Tests for model_usage helpers.
"""

import argparse
from datetime import date, timedelta
from unittest import TestCase, main

from model_usage import (
    aggregate_model_usages,
    build_json_all,
    filter_by_days,
    positive_int,
    render_text_all,
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

    def test_aggregate_model_usages_sums_cost_and_tokens_by_model(self):
        entries = [
            {
                "date": "2026-05-04",
                "modelBreakdowns": [
                    {
                        "modelName": "gpt-5.5",
                        "cost": 1.25,
                        "inputTokens": 100,
                        "outputTokens": 25,
                        "cacheReadTokens": 10,
                        "cacheCreationTokens": 5,
                        "totalTokens": 140,
                    },
                    {
                        "modelName": "glm-5.1",
                        "cost": 0.50,
                        "inputTokens": 200,
                        "outputTokens": 80,
                    },
                ],
            },
            {
                "date": "2026-05-05",
                "modelBreakdowns": [
                    {
                        "modelName": "gpt-5.5",
                        "cost": 0.75,
                        "prompt_tokens": 20,
                        "completion_tokens": 10,
                        "total_tokens": 30,
                    }
                ],
            },
        ]

        totals = aggregate_model_usages(entries)

        self.assertEqual(totals["gpt-5.5"].cost, 2.0)
        self.assertEqual(totals["gpt-5.5"].input_tokens, 120)
        self.assertEqual(totals["gpt-5.5"].output_tokens, 35)
        self.assertEqual(totals["gpt-5.5"].cache_read_tokens, 10)
        self.assertEqual(totals["gpt-5.5"].cache_creation_tokens, 5)
        self.assertEqual(totals["gpt-5.5"].total_tokens, 170)
        self.assertTrue(totals["gpt-5.5"].tokens_available)
        self.assertEqual(totals["glm-5.1"].total_tokens, 280)

    def test_all_outputs_include_token_usage_for_each_model(self):
        entries = [
            {
                "modelBreakdowns": [
                    {"modelName": "gpt-5.5", "cost": 2.0, "inputTokens": 100, "outputTokens": 50},
                    {"modelName": "glm-5.1", "cost": 1.0},
                ]
            }
        ]
        totals = aggregate_model_usages(entries)

        text = render_text_all("codex", totals)
        payload = build_json_all("codex", totals)

        self.assertIn("gpt-5.5: $2.00, tokens 150", text)
        self.assertIn("glm-5.1: $1.00, tokens unavailable", text)
        self.assertEqual(payload["models"][0]["totalTokens"], 150)
        self.assertTrue(payload["models"][0]["tokensAvailable"])
        self.assertIsNone(payload["models"][1]["totalTokens"])
        self.assertFalse(payload["models"][1]["tokensAvailable"])


if __name__ == "__main__":
    main()

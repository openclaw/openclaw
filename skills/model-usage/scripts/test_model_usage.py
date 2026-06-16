#!/usr/bin/env python3
"""
Tests for model_usage helpers.
"""

import argparse
from datetime import date, timedelta
from unittest import TestCase, main

from model_usage import filter_by_days, parse_date, positive_int


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


class TestParseDate(TestCase):
    def test_parses_valid_iso_date(self):
        self.assertEqual(parse_date("2025-03-20"), date(2025, 3, 20))

    def test_returns_none_for_malformed_date(self):
        self.assertIsNone(parse_date("not-a-date"))
        self.assertIsNone(parse_date("2025/03/20"))
        self.assertIsNone(parse_date("2025-13-01"))
        self.assertIsNone(parse_date(""))

    def test_returns_none_for_non_string_input(self):
        # strptime coerces ints in some Python builds but is unhappy with None
        self.assertIsNone(parse_date(None))
        self.assertIsNone(parse_date(20250320))

    def test_does_not_swallow_keyboard_interrupt(self):
        from unittest.mock import patch

        # Simulate a stray KeyboardInterrupt that used to be silently
        # absorbed by the previous `except Exception:` blanket.
        with patch(
            "model_usage.datetime"
        ) as fake_datetime:
            fake_datetime.strptime.side_effect = KeyboardInterrupt
            with self.assertRaises(KeyboardInterrupt):
                parse_date("2025-03-20")


if __name__ == "__main__":
    main()

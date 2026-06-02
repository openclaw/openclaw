#!/usr/bin/env python3
"""
Tests for the utility functions that were part of the autoreview script
(deleted in the .agents skills cleanup PR). The pure functions are inlined
here to preserve behavioral documentation and regression coverage.

Source: .agents/skills/autoreview/scripts/autoreview (removed)
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from types import SimpleNamespace
from unittest import TestCase, main


# ---------------------------------------------------------------------------
# Inlined pure utility functions extracted from the deleted autoreview script
# ---------------------------------------------------------------------------

def bounded(text: str, limit: int = 180_000) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n\n[truncated at {limit} characters]\n"


def bounded_field(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    suffix = "\n\n[truncated]"
    return text[: max(0, limit - len(suffix))] + suffix


def number_in_range(value) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and 0 <= value <= 1


def parse_json_candidate(text: str):
    stripped = text.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        if lines and lines[0].startswith("```") and lines[-1].strip() == "```":
            stripped = "\n".join(lines[1:-1]).strip()
    try:
        parsed = json.loads(stripped)
    except json.JSONDecodeError:
        return None
    if isinstance(parsed, str) and parsed != text:
        nested = parse_json_candidate(parsed)
        return nested if nested is not None else parsed
    return parsed


def extract_json_from_jsonl(text: str):
    candidates = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        part = event.get("part")
        if isinstance(part, dict) and isinstance(part.get("text"), str):
            candidates.append(part["text"])
        data = event.get("data")
        if isinstance(data, dict) and isinstance(data.get("content"), str):
            candidates.append(data["content"])
        if isinstance(event.get("result"), str):
            candidates.append(event["result"])
        if isinstance(event.get("structured_output"), dict):
            candidates.append(event["structured_output"])
    for candidate in reversed(candidates):
        if isinstance(candidate, dict):
            if "findings" in candidate:
                return candidate
            continue
        parsed = parse_json_candidate(candidate)
        if isinstance(parsed, dict) and "findings" in parsed:
            return parsed
    return None


ENGINES = ("codex", "claude", "droid", "copilot")
THINKING_LEVELS_BY_ENGINE = {
    "codex": {"low", "medium", "high", "xhigh"},
    "claude": {"low", "medium", "high", "xhigh", "max"},
    "droid": set(),
    "copilot": set(),
}


def parse_reviewer_token(token: str):
    parts = [p.strip() for p in token.split(":")]
    if len(parts) > 3 or not parts[0]:
        raise SystemExit(f"invalid reviewer spec: {token}")
    engine = parts[0]
    if engine not in ENGINES:
        raise SystemExit(f"unknown reviewer engine: {engine}")
    model = parts[1] if len(parts) >= 2 and parts[1] else None
    thinking = parts[2] if len(parts) == 3 and parts[2] else None
    return engine, model, thinking


def reviewer_label(args) -> str:
    parts = [args.engine]
    if args.model:
        parts.append(f"model={args.model}")
    if args.thinking:
        parts.append(f"thinking={args.thinking}")
    return " ".join(parts)


def compactToolSummary(family_counts: dict, dropped: int) -> str:
    families: dict[str, int] = {}
    for family, count in family_counts.items():
        families[family] = families.get(family, 0) + count
    ordered = [
        f"{families[f]} {f}"
        for f in ["read", "write", "execute", "network", "other"]
        if families.get(f, 0) > 0
    ]
    calls = ", ".join(ordered) if ordered else "0 tool"
    return f"{calls}; raw tool outputs dropped: {dropped}"


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestBounded(TestCase):
    def test_returns_text_unchanged_when_within_limit(self):
        text = "short text"
        self.assertEqual(bounded(text, 100), text)

    def test_truncates_when_over_limit(self):
        text = "a" * 200
        result = bounded(text, 100)
        self.assertLess(len(result), 200)
        self.assertIn("[truncated at 100 characters]", result)

    def test_truncated_prefix_matches_original(self):
        text = "hello world " * 20
        result = bounded(text, 50)
        self.assertTrue(result.startswith(text[:50]))

    def test_default_limit_allows_large_text(self):
        text = "x" * 100_000
        self.assertEqual(bounded(text), text)

    def test_exact_limit_is_not_truncated(self):
        text = "a" * 100
        self.assertEqual(bounded(text, 100), text)

    def test_one_over_limit_is_truncated(self):
        text = "a" * 101
        result = bounded(text, 100)
        self.assertIn("[truncated at 100 characters]", result)

    def test_empty_string_is_not_truncated(self):
        self.assertEqual(bounded("", 10), "")


class TestBoundedField(TestCase):
    def test_returns_text_unchanged_within_limit(self):
        text = "short"
        self.assertEqual(bounded_field(text, 100), text)

    def test_truncates_with_truncated_suffix(self):
        text = "a" * 200
        result = bounded_field(text, 50)
        self.assertTrue(result.endswith("\n\n[truncated]"))
        self.assertLessEqual(len(result), 50)

    def test_suffix_is_included_in_limit(self):
        limit = 30
        result = bounded_field("a" * 100, limit)
        self.assertLessEqual(len(result), limit)

    def test_exact_limit_is_not_truncated(self):
        text = "a" * 20
        self.assertEqual(bounded_field(text, 20), text)

    def test_handles_zero_limit_gracefully(self):
        result = bounded_field("hello", 0)
        # Should return suffix or empty – never crash
        self.assertIsInstance(result, str)


class TestNumberInRange(TestCase):
    def test_accepts_zero(self):
        self.assertTrue(number_in_range(0))

    def test_accepts_one(self):
        self.assertTrue(number_in_range(1))

    def test_accepts_float_in_range(self):
        self.assertTrue(number_in_range(0.75))
        self.assertTrue(number_in_range(0.5))

    def test_rejects_negative(self):
        self.assertFalse(number_in_range(-0.1))
        self.assertFalse(number_in_range(-1))

    def test_rejects_above_one(self):
        self.assertFalse(number_in_range(1.1))
        self.assertFalse(number_in_range(2))

    def test_rejects_boolean_true(self):
        # bool is a subclass of int but should be rejected
        self.assertFalse(number_in_range(True))

    def test_rejects_boolean_false(self):
        self.assertFalse(number_in_range(False))

    def test_rejects_string(self):
        self.assertFalse(number_in_range("0.5"))

    def test_rejects_none(self):
        self.assertFalse(number_in_range(None))

    def test_rejects_list(self):
        self.assertFalse(number_in_range([0.5]))


class TestParseJsonCandidate(TestCase):
    def test_parses_plain_json(self):
        result = parse_json_candidate('{"findings": [], "overall_correctness": "patch is correct"}')
        self.assertIsInstance(result, dict)
        self.assertIn("findings", result)

    def test_parses_json_inside_markdown_fence(self):
        text = "```\n{\"findings\": [], \"overall_correctness\": \"patch is correct\"}\n```"
        result = parse_json_candidate(text)
        self.assertIsInstance(result, dict)
        self.assertIn("findings", result)

    def test_parses_json_inside_typed_markdown_fence(self):
        text = "```json\n{\"key\": \"value\"}\n```"
        result = parse_json_candidate(text)
        self.assertIsInstance(result, dict)
        self.assertEqual(result["key"], "value")

    def test_returns_none_for_invalid_json(self):
        self.assertIsNone(parse_json_candidate("not json at all"))

    def test_returns_none_for_empty_string(self):
        self.assertIsNone(parse_json_candidate(""))

    def test_returns_none_for_whitespace_only(self):
        self.assertIsNone(parse_json_candidate("   "))

    def test_returns_list_for_json_array(self):
        result = parse_json_candidate("[1, 2, 3]")
        self.assertEqual(result, [1, 2, 3])

    def test_handles_nested_json_string(self):
        # A JSON string whose value is also JSON
        inner = json.dumps({"findings": [], "overall_correctness": "patch is correct"})
        outer = json.dumps(inner)
        result = parse_json_candidate(outer)
        self.assertIsInstance(result, dict)
        self.assertIn("findings", result)


class TestExtractJsonFromJsonl(TestCase):
    def test_extracts_structured_output_field(self):
        payload = {"findings": [], "overall_correctness": "patch is correct",
                   "overall_explanation": "ok", "overall_confidence": 0.9}
        line = json.dumps({"structured_output": payload})
        result = extract_json_from_jsonl(line)
        self.assertIsNotNone(result)
        self.assertIn("findings", result)

    def test_extracts_result_string_field(self):
        inner = json.dumps({"findings": [], "overall_correctness": "patch is correct",
                            "overall_explanation": "ok", "overall_confidence": 0.9})
        line = json.dumps({"result": inner})
        result = extract_json_from_jsonl(line)
        self.assertIsNotNone(result)
        self.assertIn("findings", result)

    def test_returns_none_for_unrecognised_jsonl(self):
        line = json.dumps({"unrelated": "data"})
        result = extract_json_from_jsonl(line)
        self.assertIsNone(result)

    def test_returns_none_for_empty_string(self):
        self.assertIsNone(extract_json_from_jsonl(""))

    def test_returns_none_for_non_json_lines(self):
        self.assertIsNone(extract_json_from_jsonl("not json at all"))

    def test_prefers_last_candidate(self):
        # Two lines; the second should win because candidates are reversed
        first_payload = {"findings": [{"title": "first"}],
                         "overall_correctness": "patch is incorrect",
                         "overall_explanation": "x", "overall_confidence": 0.5}
        second_payload = {"findings": [],
                          "overall_correctness": "patch is correct",
                          "overall_explanation": "y", "overall_confidence": 0.9}
        lines = "\n".join([
            json.dumps({"structured_output": first_payload}),
            json.dumps({"structured_output": second_payload}),
        ])
        result = extract_json_from_jsonl(lines)
        self.assertIsNotNone(result)
        self.assertEqual(result["overall_correctness"], "patch is correct")

    def test_extracts_part_text_field(self):
        inner = json.dumps({"findings": [], "overall_correctness": "patch is correct",
                            "overall_explanation": "ok", "overall_confidence": 0.9})
        line = json.dumps({"part": {"text": inner}})
        result = extract_json_from_jsonl(line)
        self.assertIsNotNone(result)
        self.assertIn("findings", result)


class TestParseReviewerToken(TestCase):
    def test_parses_engine_only(self):
        engine, model, thinking = parse_reviewer_token("codex")
        self.assertEqual(engine, "codex")
        self.assertIsNone(model)
        self.assertIsNone(thinking)

    def test_parses_engine_and_model(self):
        engine, model, thinking = parse_reviewer_token("codex:gpt-5")
        self.assertEqual(engine, "codex")
        self.assertEqual(model, "gpt-5")
        self.assertIsNone(thinking)

    def test_parses_full_spec(self):
        engine, model, thinking = parse_reviewer_token("codex:gpt-5.1:high")
        self.assertEqual(engine, "codex")
        self.assertEqual(model, "gpt-5.1")
        self.assertEqual(thinking, "high")

    def test_parses_claude_with_max_thinking(self):
        engine, model, thinking = parse_reviewer_token("claude:sonnet:max")
        self.assertEqual(engine, "claude")
        self.assertEqual(model, "sonnet")
        self.assertEqual(thinking, "max")

    def test_raises_for_unknown_engine(self):
        with self.assertRaises(SystemExit):
            parse_reviewer_token("unknown-engine")

    def test_raises_for_too_many_parts(self):
        with self.assertRaises(SystemExit):
            parse_reviewer_token("codex:model:thinking:extra")

    def test_raises_for_empty_token(self):
        with self.assertRaises(SystemExit):
            parse_reviewer_token("")

    def test_treats_empty_model_part_as_none(self):
        engine, model, thinking = parse_reviewer_token("codex::high")
        self.assertEqual(engine, "codex")
        self.assertIsNone(model)
        self.assertEqual(thinking, "high")

    def test_all_known_engines_are_accepted(self):
        for engine in ENGINES:
            parsed_engine, _, _ = parse_reviewer_token(engine)
            self.assertEqual(parsed_engine, engine)


class TestReviewerLabel(TestCase):
    def test_engine_only(self):
        args = SimpleNamespace(engine="codex", model=None, thinking=None)
        self.assertEqual(reviewer_label(args), "codex")

    def test_engine_with_model(self):
        args = SimpleNamespace(engine="codex", model="gpt-5", thinking=None)
        self.assertEqual(reviewer_label(args), "codex model=gpt-5")

    def test_engine_with_model_and_thinking(self):
        args = SimpleNamespace(engine="claude", model="sonnet", thinking="max")
        self.assertEqual(reviewer_label(args), "claude model=sonnet thinking=max")

    def test_engine_with_thinking_only(self):
        args = SimpleNamespace(engine="codex", model=None, thinking="high")
        self.assertEqual(reviewer_label(args), "codex thinking=high")

    def test_all_engines_produce_labels(self):
        for engine in ENGINES:
            args = SimpleNamespace(engine=engine, model=None, thinking=None)
            label = reviewer_label(args)
            self.assertIn(engine, label)


class TestCompactToolSummary(TestCase):
    def test_single_family(self):
        result = compactToolSummary({"read": 5}, 3)
        self.assertIn("5 read", result)
        self.assertIn("raw tool outputs dropped: 3", result)

    def test_multiple_families_ordered(self):
        result = compactToolSummary({"execute": 2, "read": 4, "write": 1}, 0)
        # Order: read, write, execute, network, other
        read_pos = result.index("read")
        write_pos = result.index("write")
        exec_pos = result.index("execute")
        self.assertLess(read_pos, write_pos)
        self.assertLess(write_pos, exec_pos)

    def test_empty_family_counts(self):
        result = compactToolSummary({}, 0)
        self.assertIn("0 tool", result)
        self.assertIn("raw tool outputs dropped: 0", result)

    def test_dropped_count_included(self):
        result = compactToolSummary({"read": 1}, 42)
        self.assertIn("raw tool outputs dropped: 42", result)

    def test_zero_dropped(self):
        result = compactToolSummary({"write": 3}, 0)
        self.assertIn("raw tool outputs dropped: 0", result)

    def test_network_family(self):
        result = compactToolSummary({"network": 7}, 0)
        self.assertIn("7 network", result)

    def test_omits_families_with_zero_count(self):
        result = compactToolSummary({"read": 2}, 0)
        self.assertNotIn("write", result)
        self.assertNotIn("execute", result)
        self.assertNotIn("network", result)
        self.assertNotIn("other", result)


if __name__ == "__main__":
    main()
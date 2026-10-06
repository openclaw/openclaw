"""Terminal report authority and supported output formats."""
from __future__ import annotations

import argparse
import copy
import json
import unittest
from pathlib import Path
from unittest import mock

from .test_autoreview_hardening import load_helper


EARLIER_REPORT = {
    "findings": [],
    "overall_correctness": "patch is correct",
    "overall_explanation": "Earlier synthetic terminal report.",
    "overall_confidence": 0.9,
    "review_completion": "complete",
}
FINAL_REPORT = {
    "findings": [],
    "overall_correctness": "patch is incorrect",
    "overall_explanation": "Final synthetic terminal report.",
    "overall_confidence": 0.7,
    "review_completion": "complete",
}
JSON_STRING_SEPARATORS = ("\u0085", "\u2028", "\u2029")


class TerminalReportAuthorityTests(unittest.TestCase):
    def setUp(self):
        self.helper = load_helper()

    @staticmethod
    def terminal(payload):
        return {"type": "result", "subtype": "success", "result": payload}

    @staticmethod
    def representations(events):
        return (
            ("jsonl", "\n".join(json.dumps(event) for event in events)),
            ("json-array", json.dumps(events)),
        )

    def assert_both_refuse(self, events):
        for label, raw in self.representations(events):
            with self.subTest(format=label):
                with self.assertRaises(SystemExit):
                    self.helper["extract_json"](raw)

    def assert_both_equal(self, events, expected):
        for label, raw in self.representations(events):
            with self.subTest(format=label):
                self.assertEqual(self.helper["extract_json"](raw), expected)

    def test_malformed_last_terminal_never_reuses_earlier_clean_terminal(self):
        self.assert_both_refuse([
            self.terminal(EARLIER_REPORT),
            self.terminal("not json"),
        ])

    def test_nonreport_last_terminal_is_authoritative_even_with_bad_payload_type(self):
        for payload in (None, [], 42, False, {}, {"usage": 1}, "", "[]", "42"):
            with self.subTest(payload=payload):
                self.assert_both_refuse([
                    self.terminal(EARLIER_REPORT),
                    self.terminal(payload),
                ])

    def test_known_terminal_without_report_payload_blocks_earlier_report(self):
        self.assert_both_refuse([
            self.terminal(EARLIER_REPORT),
            {"type": "result", "subtype": "error", "error": "synthetic failure"},
        ])

    def test_untyped_result_wrapper_cannot_hide_a_bad_final_payload(self):
        for payload in (None, [], 42):
            with self.subTest(payload=payload):
                self.assert_both_refuse([{"result": EARLIER_REPORT}, {"result": payload}])

    def test_latest_valid_terminal_wins_over_earlier_bad_or_clean_terminal(self):
        for earlier in ("not json", EARLIER_REPORT):
            with self.subTest(earlier=earlier):
                self.assert_both_equal([
                    self.terminal(earlier), self.terminal(FINAL_REPORT),
                ], FINAL_REPORT)

    def test_later_progress_does_not_replace_the_last_terminal(self):
        self.assert_both_equal([
            self.terminal(FINAL_REPORT),
            {"type": "progress", "text": "synthetic statistics"},
        ], FINAL_REPORT)

    def test_structured_output_has_priority_within_the_final_terminal(self):
        self.assert_both_equal([
            self.terminal(EARLIER_REPORT),
            {"type": "result", "result": EARLIER_REPORT, "structured_output": FINAL_REPORT},
        ], FINAL_REPORT)

    def test_bad_authoritative_structured_output_cannot_fallback_within_event(self):
        for invalid in ({"usage": 1}, [], False, 42, "", "not json", json.dumps(FINAL_REPORT)):
            with self.subTest(structured_output=invalid):
                event = {"type": "result", "result": FINAL_REPORT, "structured_output": invalid}
                self.assert_both_refuse([self.terminal(EARLIER_REPORT), event])
                with self.assertRaises(SystemExit):
                    self.helper["extract_json"](json.dumps(event))

    def test_earlier_bad_structured_output_does_not_override_valid_final_terminal(self):
        self.assert_both_equal([
            {"type": "result", "result": EARLIER_REPORT, "structured_output": []},
            self.terminal(FINAL_REPORT),
        ], FINAL_REPORT)

    def test_terminal_failure_cannot_fallback_to_assistant_or_text_candidates(self):
        self.assert_both_refuse([
            {"type": "assistant", "message": {"content": [
                {"type": "text", "text": json.dumps(EARLIER_REPORT)},
            ]}},
            {"type": "text", "part": {"text": json.dumps(EARLIER_REPORT)}},
            self.terminal("not json"),
        ])

    def test_valid_nonterminal_fallbacks_remain_supported(self):
        self.assert_both_equal([
            {"type": "assistant", "message": {"content": [
                {"type": "text", "text": json.dumps(FINAL_REPORT)},
            ]}},
        ], FINAL_REPORT)
        text = json.dumps(FINAL_REPORT)
        midpoint = len(text) // 2
        self.assert_both_equal([
            {"type": "text", "part": {"text": text[:midpoint]}},
            {"type": "text", "part": {"text": text[midpoint:]}},
        ], FINAL_REPORT)

    def test_valid_direct_report_and_wrapper_contracts_remain_supported(self):
        encoded = json.dumps(FINAL_REPORT)
        fenced = f"```json\n{encoded}\n```"
        for payload in (
            FINAL_REPORT,
            {"structured_output": FINAL_REPORT},
            {"result": FINAL_REPORT},
            {"result": encoded},
            {"result": fenced},
            {"result": json.dumps(encoded)},
            {"type": "result", "result": FINAL_REPORT, "structured_output": None},
        ):
            for indent in (None, 2):
                with self.subTest(payload=payload, indent=indent):
                    self.assertEqual(self.helper["extract_json"](json.dumps(payload, indent=indent)), FINAL_REPORT)
        self.assertEqual(self.helper["extract_json"](fenced), FINAL_REPORT)
        self.assert_both_equal([{"result": FINAL_REPORT}], FINAL_REPORT)
        self.assert_both_equal([{"structured_output": FINAL_REPORT}], FINAL_REPORT)
        self.assert_both_equal([
            {"type": "result", "result": FINAL_REPORT, "structured_output": None},
        ], FINAL_REPORT)

    @staticmethod
    def final_report_with_unicode(separator):
        return {
            **FINAL_REPORT,
            "findings": [{
                "title": "Final synthetic defect",
                "body": f"The final finding retains Unicode{separator}inside a JSON string.",
                "priority": "P0",
                "confidence": 0.9,
                "category": "bug",
                "code_location": {"file_path": "source.txt", "line": 1},
                "source_attribution": None,
            }],
            "overall_explanation": f"Final synthetic report{separator}with a P0 finding.",
        }

    def test_jsonl_unicode_strings_match_escaped_encoding(self):
        for separator in JSON_STRING_SEPARATORS:
            payload = self.final_report_with_unicode(separator)
            for ensure_ascii in (True, False):
                with self.subTest(separator=ascii(separator), ensure_ascii=ensure_ascii):
                    raw = json.dumps(self.terminal(payload), ensure_ascii=ensure_ascii)
                    self.assertEqual(self.helper["extract_json_from_jsonl"](raw), payload)

    def test_jsonl_lf_and_crlf_keep_blank_and_noise_behavior(self):
        for ending in ("\n", "\r\n"):
            with self.subTest(ending=repr(ending)):
                raw = ending.join([
                    "", " \t", "synthetic startup noise",
                    json.dumps(self.terminal(EARLIER_REPORT)), "",
                    json.dumps({"type": "progress", "text": "synthetic progress"}),
                    json.dumps(self.terminal(FINAL_REPORT)), "not JSON", " \t", "",
                ])
                self.assertEqual(self.helper["extract_json_from_jsonl"](raw), FINAL_REPORT)
                self.assertEqual(self.helper["extract_json"](raw), FINAL_REPORT)

    def test_single_record_and_array_unicode_controls_remain_supported(self):
        payload = self.final_report_with_unicode("".join(JSON_STRING_SEPARATORS))
        for events in (self.terminal(payload), [self.terminal(payload)]):
            with self.subTest(array=isinstance(events, list)):
                raw = json.dumps(events, ensure_ascii=False)
                self.assertEqual(self.helper["extract_json"](raw), payload)

    def test_final_unicode_p0_jsonl_remains_authoritative_and_completion_private(self):
        for completion in ("complete", "incomplete"):
            payload = {
                **self.final_report_with_unicode("".join(JSON_STRING_SEPARATORS)),
                "review_completion": completion,
            }
            public = {key: value for key, value in payload.items() if key != "review_completion"}
            for ensure_ascii in (True, False):
                raw = "\n".join(json.dumps(event, ensure_ascii=ensure_ascii) for event in (
                    self.terminal(EARLIER_REPORT), self.terminal(payload),
                ))
                args = argparse.Namespace(engine="codex", max_priority="P0")
                with self.subTest(completion=completion, ensure_ascii=ensure_ascii), mock.patch.dict(
                    self.helper["run_reviewer"].__globals__, {"run_engine": lambda *_args: raw},
                ):
                    result = self.helper["run_reviewer"](
                        args, Path.cwd(), "synthetic prompt", {"source.txt"}, [],
                    )
                    self.assertEqual(result.report, {**public, "provider_report": public})
                    self.assertEqual(result.complete, completion == "complete")
                    self.assertEqual(
                        self.helper["review_status"](result.report, complete=result.complete),
                        "findings" if completion == "complete" else "incomplete",
                    )

    def test_final_unicode_jsonl_still_requires_valid_completion(self):
        for completion in (None, "deferred"):
            payload = self.final_report_with_unicode("".join(JSON_STRING_SEPARATORS))
            if completion is None:
                payload.pop("review_completion")
            else:
                payload["review_completion"] = completion
            for ensure_ascii in (True, False):
                raw = "\n".join(json.dumps(event, ensure_ascii=ensure_ascii) for event in (
                    self.terminal(EARLIER_REPORT), self.terminal(payload),
                ))
                args = argparse.Namespace(engine="codex", max_priority="P0")
                with self.subTest(completion=completion, ensure_ascii=ensure_ascii), mock.patch.dict(
                    self.helper["run_reviewer"].__globals__, {"run_engine": lambda *_args: raw},
                ):
                    with self.assertRaises(self.helper["ReviewerUnavailable"]) as caught:
                        self.helper["run_reviewer"](
                            args, Path.cwd(), "synthetic prompt", {"source.txt"}, [],
                        )
                    self.assertEqual(caught.exception.reason, "invalid_report")
                    self.assertIn("review_completion", str(caught.exception))

    def test_shared_gateway_keeps_completion_private_for_valid_final_report(self):
        for completion in ("complete", "incomplete"):
            payload = {**FINAL_REPORT, "review_completion": completion}
            args = argparse.Namespace(engine="codex", max_priority="P2")
            with self.subTest(completion=completion), mock.patch.dict(
                self.helper["run_reviewer"].__globals__, {"run_engine": lambda *_args: json.dumps(payload)},
            ):
                result = self.helper["run_reviewer"](args, Path.cwd(), "synthetic prompt", set(), [])
            self.assertEqual(result.complete, completion == "complete")
            self.assertNotIn("review_completion", result.report)
            self.assertNotIn("review_completion", result.report["provider_report"])
            for field in ("findings", "overall_correctness", "overall_explanation", "overall_confidence"):
                self.assertEqual(result.report[field], FINAL_REPORT[field])

    def test_shared_gateway_classifies_bad_final_as_invalid_for_every_engine(self):
        # Engine-return boundary only: no engine wrapper, process, or auth runs.
        raw = self.representations([
            self.terminal(EARLIER_REPORT), self.terminal("not json"),
        ])[0][1]
        for engine in ("pi", "codex", "claude", "amp", "kimi"):
            args = argparse.Namespace(engine=engine, max_priority="P2")
            with self.subTest(engine=engine), mock.patch.dict(
                self.helper["run_reviewer"].__globals__, {"run_engine": lambda *_args: raw},
            ):
                with self.assertRaises(self.helper["ReviewerUnavailable"]) as caught:
                    self.helper["run_reviewer"](args, Path.cwd(), "synthetic prompt", set(), [])
                self.assertEqual(caught.exception.reason, "invalid_report")

    def test_later_failed_pass_does_not_return_partial_clean_passes(self):
        args = argparse.Namespace(engine="codex", max_priority="P2")
        broken = self.representations([
            self.terminal(EARLIER_REPORT), self.terminal("not json"),
        ])[1][1]
        engine = mock.Mock(side_effect=[json.dumps(copy.deepcopy(EARLIER_REPORT)), broken])
        with mock.patch.dict(self.helper["run_reviewer"].__globals__, {"run_engine": engine}):
            with self.assertRaises(self.helper["ReviewerUnavailable"]) as caught:
                self.helper["run_review_passes"](
                    args, [args], Path.cwd(), ["first synthetic prompt", "second synthetic prompt"], set(),
                )
        self.assertEqual(caught.exception.reason, "invalid_report")
        self.assertEqual(engine.call_count, 2)

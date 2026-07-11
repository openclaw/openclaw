#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import runpy
import subprocess
import sys
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path
from unittest import mock


SCRIPT_PATH = Path(__file__).with_name("autoreview")
LOADER = SourceFileLoader("autoreview_module", str(SCRIPT_PATH))
SPEC = importlib.util.spec_from_loader(LOADER.name, LOADER)
assert SPEC is not None
AUTOREVIEW = importlib.util.module_from_spec(SPEC)
LOADER.exec_module(AUTOREVIEW)


FINAL_REPORT = {
    "findings": [],
    "overall_correctness": "patch is correct",
    "overall_explanation": "clean",
    "overall_confidence": 0.9,
}

DRAFT_REPORT = {
    "findings": [
        {
            "title": "Draft finding",
            "body": "draft",
            "priority": "P3",
            "confidence": 0.2,
            "category": "maintainability",
            "code_location": {"file_path": "draft.js", "line": 1},
        }
    ],
    "overall_correctness": "patch is incorrect",
    "overall_explanation": "draft",
    "overall_confidence": 0.2,
}


class AutoreviewCursorTests(unittest.TestCase):
    def test_extract_json_prefers_terminal_result_event(self) -> None:
        stream = "\n".join(
            [
                json.dumps(
                    {
                        "type": "assistant",
                        "message": {"role": "assistant", "content": [{"type": "text", "text": json.dumps(DRAFT_REPORT)}]},
                    }
                ),
                json.dumps(
                    {
                        "type": "result",
                        "subtype": "success",
                        "result": json.dumps(FINAL_REPORT),
                        "session_id": "session-id",
                        "request_id": "request-id",
                    }
                ),
            ]
        )
        self.assertEqual(AUTOREVIEW.extract_json(stream), FINAL_REPORT)

    def test_extract_json_can_fallback_to_assistant_message(self) -> None:
        stream = json.dumps(
            {
                "type": "assistant",
                "message": {"role": "assistant", "content": [{"type": "text", "text": json.dumps(FINAL_REPORT)}]},
            }
        )
        self.assertEqual(AUTOREVIEW.extract_json(stream), FINAL_REPORT)

    def test_extract_json_does_not_fallback_past_bad_terminal_result(self) -> None:
        stream = "\n".join(
            [
                json.dumps(
                    {
                        "type": "assistant",
                        "message": {"role": "assistant", "content": [{"type": "text", "text": json.dumps(FINAL_REPORT)}]},
                    }
                ),
                json.dumps(
                    {
                        "type": "result",
                        "subtype": "success",
                        "result": "not json",
                    }
                ),
            ]
        )
        with self.assertRaises(SystemExit) as exc_info:
            AUTOREVIEW.extract_json(stream)
        self.assertIn("review engine result was not structured JSON", str(exc_info.exception))


class AutoreviewCompatibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.home_dir = tempfile.TemporaryDirectory(prefix="autoreview-test-home.")
        cls.home_patch = mock.patch.object(Path, "home", return_value=Path(cls.home_dir.name))
        cls.home_patch.start()
        cls.home_keys = ("HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH")
        cls.old_home_env = {key: os.environ.get(key) for key in cls.home_keys}
        os.environ["HOME"] = cls.home_dir.name
        os.environ["USERPROFILE"] = cls.home_dir.name
        os.environ.pop("HOMEDRIVE", None)
        os.environ.pop("HOMEPATH", None)

    @classmethod
    def tearDownClass(cls) -> None:
        cls.home_patch.stop()
        for key, value in cls.old_home_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        cls.home_dir.cleanup()

    def test_harness_opts_both_cursor_aliases_into_trusted_fixture(self) -> None:
        harness_path = SCRIPT_PATH.with_name("test-review-harness.py")
        namespace = runpy.run_path(str(harness_path))
        commands: list[list[str]] = []
        run_reviews = namespace["run_reviews"]
        with mock.patch.dict(
            run_reviews.__globals__,
            {
                "run": lambda command, _cwd: commands.append(command),
                "validate_prompt_policy": lambda _repo, _autoreview: None,
            },
        ), tempfile.TemporaryDirectory(prefix="autoreview-harness-test.") as tmpdir:
            run_reviews(Path(tmpdir), SCRIPT_PATH.parent, "benign", ["cursor", "cursor-agent"])
        self.assertEqual(len(commands), 2)
        for command in commands:
            self.assertIn("--cursor-allow-workspace-instructions", command)

    def test_cursor_agent_bin_cli_alias(self) -> None:
        with mock.patch.object(
            sys,
            "argv",
            ["autoreview", "--cursor-agent-bin", "/tmp/legacy-cursor"],
        ):
            args = AUTOREVIEW.parse_args()
        self.assertEqual(args.cursor_bin, "/tmp/legacy-cursor")

    def test_cursor_agent_bin_env_alias(self) -> None:
        with mock.patch.dict(
            os.environ,
            {"CURSOR_AGENT_BIN": "/tmp/legacy-cursor"},
            clear=False,
        ):
            os.environ.pop("CURSOR_BIN", None)
            with mock.patch.object(sys, "argv", ["autoreview"]):
                args = AUTOREVIEW.parse_args()
        self.assertEqual(args.cursor_bin, "/tmp/legacy-cursor")

    def test_cursor_agent_reviewer_alias_normalizes_to_cursor(self) -> None:
        self.assertEqual(
            AUTOREVIEW.parse_reviewer_token("cursor-agent:auto"),
            ("cursor", "auto", None),
        )

    def test_cursor_agent_keyed_option_normalizes_to_cursor(self) -> None:
        self.assertEqual(
            AUTOREVIEW.parse_keyed_options(["cursor-agent=auto"], "model"),
            (None, {"cursor": "auto"}),
        )

    def test_codex_config_status_exposes_keys_only(self) -> None:
        args = argparse.Namespace(codex_config=['model_provider="private-value"'])
        self.assertEqual(AUTOREVIEW.codex_config_keys(args), ["model_provider"])

    def test_extract_json_accepts_dict_result_payload(self) -> None:
        payload = {
            "type": "result",
            "subtype": "success",
            "result": FINAL_REPORT,
            "session_id": "session-id",
            "request_id": "request-id",
        }
        self.assertEqual(AUTOREVIEW.extract_json(json.dumps(payload)), FINAL_REPORT)

    def test_extract_json_accepts_result_string_with_preamble(self) -> None:
        payload = {
            "type": "result",
            "subtype": "success",
            "result": "Inspecting the diff first.\n" + json.dumps(FINAL_REPORT),
        }
        self.assertEqual(AUTOREVIEW.extract_json(json.dumps(payload)), FINAL_REPORT)

    def test_extract_findings_json_from_text_prefers_last_findings_object(self) -> None:
        later_report = {
            "findings": [
                {
                    "title": "Later finding",
                    "body": "later",
                    "priority": "P2",
                    "confidence": 0.8,
                    "category": "bug",
                    "code_location": {"file_path": "later.js", "line": 2},
                }
            ],
            "overall_correctness": "patch is incorrect",
            "overall_explanation": "later",
            "overall_confidence": 0.8,
        }
        text = f"{json.dumps(FINAL_REPORT)} separator {json.dumps(later_report)}"
        self.assertEqual(AUTOREVIEW.extract_findings_json_from_text(text), later_report)

    def test_retry_filter_only_matches_parse_failures(self) -> None:
        self.assertTrue(AUTOREVIEW.is_structured_output_failure("review engine returned non-JSON output: nope"))
        self.assertTrue(AUTOREVIEW.is_structured_output_failure("review engine result was not structured JSON:\nnope"))
        self.assertFalse(AUTOREVIEW.is_structured_output_failure("review JSON missing required key: findings"))
        self.assertFalse(AUTOREVIEW.is_structured_output_failure("finding 0 has invalid priority"))

    def test_cursor_workspace_instructions_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory(prefix="autoreview-cursor-test.") as tmpdir:
            repo = Path(tmpdir)
            args = argparse.Namespace(
                thinking=None,
                tools=True,
                web_search=True,
                cursor_allow_workspace_instructions=False,
                cursor_bin="cursor-agent",
                model="auto",
                stream_engine_output=False,
            )
            with self.assertRaises(SystemExit) as exc_info:
                AUTOREVIEW.run_cursor(args, repo, "prompt")
            self.assertIn("requires --cursor-allow-workspace-instructions", str(exc_info.exception))

    def test_cursor_local_mcp_requires_explicit_approval(self) -> None:
        with tempfile.TemporaryDirectory(prefix="autoreview-cursor-test.") as tmpdir:
            repo = Path(tmpdir)
            (repo / ".cursor").mkdir()
            (repo / ".cursor" / "mcp.json").write_text("{}\n")
            args = argparse.Namespace(
                thinking=None,
                tools=True,
                web_search=True,
                cursor_allow_workspace_instructions=True,
                cursor_bin="cursor-agent",
                model="auto",
                stream_engine_output=False,
            )
            with self.assertRaises(SystemExit) as exc_info:
                AUTOREVIEW.run_cursor(args, repo, "prompt")
            self.assertIn("cursor engine refused project-local MCP config", str(exc_info.exception))

    def test_cursor_local_hooks_are_always_refused(self) -> None:
        with tempfile.TemporaryDirectory(prefix="autoreview-cursor-test.") as tmpdir:
            repo = Path(tmpdir)
            (repo / ".cursor").mkdir()
            (repo / ".cursor" / "hooks.json").write_text("{}\n")
            args = argparse.Namespace(
                thinking=None,
                tools=True,
                web_search=True,
                cursor_allow_workspace_instructions=True,
                cursor_bin="cursor-agent",
                model="auto",
                stream_engine_output=False,
            )
            with self.assertRaises(SystemExit) as exc_info:
                AUTOREVIEW.run_cursor(args, repo, "prompt")
            self.assertIn("cursor engine refused project-local hooks", str(exc_info.exception))

    def test_cursor_local_permissions_are_always_refused(self) -> None:
        with tempfile.TemporaryDirectory(prefix="autoreview-cursor-test.") as tmpdir:
            repo = Path(tmpdir)
            (repo / ".cursor").mkdir()
            (repo / ".cursor" / "cli.json").write_text("{}\n")
            args = argparse.Namespace(
                thinking=None,
                tools=True,
                web_search=True,
                cursor_allow_workspace_instructions=True,
                cursor_bin="cursor-agent",
                model="auto",
                stream_engine_output=False,
            )
            with self.assertRaises(SystemExit) as exc_info:
                AUTOREVIEW.run_cursor(args, repo, "prompt")
            self.assertIn("cursor engine refused project-local permission config", str(exc_info.exception))

    def test_cursor_command_uses_current_print_contract(self) -> None:
        with tempfile.TemporaryDirectory(prefix="autoreview-cursor-test.") as tmpdir:
            root = Path(tmpdir)
            repo = root / "repo"
            repo.mkdir()
            cursor_bin = root / "cursor-agent"
            record_path = root / "record.json"
            AUTOREVIEW.write_executable(cursor_bin, AUTOREVIEW.fake_cursor_script())
            args = argparse.Namespace(
                thinking=None,
                tools=True,
                web_search=True,
                cursor_allow_workspace_instructions=True,
                cursor_bin=str(cursor_bin),
                model=None,
                stream_engine_output=False,
            )
            old_record = os.environ.get("AUTOREVIEW_FAKE_RECORD")
            try:
                os.environ["AUTOREVIEW_FAKE_RECORD"] = str(record_path)
                AUTOREVIEW.run_cursor(args, repo, "prompt")
            finally:
                if old_record is None:
                    os.environ.pop("AUTOREVIEW_FAKE_RECORD", None)
                else:
                    os.environ["AUTOREVIEW_FAKE_RECORD"] = old_record
            record = json.loads(record_path.read_text())
            self.assertEqual(Path(record["cwd"]).resolve(), repo.resolve())
            self.assertEqual(record["stdin"], "prompt")
            self.assertIn("--print", record["argv"])
            self.assertIn("--output-format", record["argv"])
            self.assertIn("json", record["argv"])
            self.assertIn("--mode", record["argv"])
            self.assertIn("ask", record["argv"])
            self.assertIn("--sandbox", record["argv"])
            self.assertIn("enabled", record["argv"])
            for unsupported in ("--workspace", "--trust"):
                self.assertNotIn(unsupported, record["argv"])

    def test_cursor_engine_runs_end_to_end_with_sanitized_environment(self) -> None:
        with tempfile.TemporaryDirectory(prefix="autoreview-cursor-e2e.") as tmpdir:
            root = Path(tmpdir)
            repo = root / "repo"
            repo.mkdir()
            subprocess.run(["git", "init", "--quiet"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.name", "AutoReview Test"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.email", "autoreview@example.invalid"], cwd=repo, check=True)
            source = repo / "example.txt"
            source.write_text("before\n")
            subprocess.run(["git", "add", "example.txt"], cwd=repo, check=True)
            subprocess.run(["git", "commit", "--quiet", "-m", "test: seed fixture"], cwd=repo, check=True)
            source.write_text("after\n")

            cursor_bin = root / "cursor-agent"
            record_path = root / "record.json"
            AUTOREVIEW.write_executable(cursor_bin, AUTOREVIEW.fake_cursor_script())
            env = os.environ.copy()
            env.update(
                {
                    "AUTOREVIEW_FAKE_RECORD": str(record_path),
                    "AUTOREVIEW_FAKE_CURSOR_INVOCATIONS": str(root / "cursor-invocations.jsonl"),
                    "GIT_CONFIG_GLOBAL": str(root / "hostile-gitconfig"),
                    "NODE_OPTIONS": "--require=hostile.js",
                    "PYTHONPATH": str(root / "hostile-python"),
                    "PATH": f"{repo}{os.pathsep}{env.get('PATH', '')}",
                }
            )
            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT_PATH),
                    "--mode",
                    "local",
                    "--engine",
                    "cursor",
                    "--cursor-bin",
                    str(cursor_bin),
                    "--cursor-allow-workspace-instructions",
                ],
                cwd=repo,
                env=env,
                text=True,
                capture_output=True,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("autoreview clean: no accepted/actionable findings reported", result.stdout)
            record = json.loads(record_path.read_text())
            self.assertEqual(Path(record["cwd"]).resolve(), repo.resolve())
            self.assertIn("diff --git a/example.txt b/example.txt", record["stdin"])
            self.assertIn("-before", record["stdin"])
            self.assertIn("+after", record["stdin"])
            self.assertEqual(record["environment"]["GIT_CONFIG_GLOBAL"], None)
            self.assertEqual(record["environment"]["NODE_OPTIONS"], None)
            self.assertEqual(record["environment"]["PYTHONPATH"], None)
            self.assertNotIn(str(repo), record["environment"]["PATH"].split(os.pathsep))
            cursor_config_dir = Path(record["environment"]["CURSOR_CONFIG_DIR"])
            self.assertFalse(cursor_config_dir.exists())
            cursor_config = json.loads(record["cursor_config"])
            self.assertEqual(cursor_config["permissions"]["allow"], ["Read(**)"])
            self.assertEqual(
                cursor_config["permissions"]["deny"],
                ["Shell(*)", "Write(**)", "Write(/**)"],
            )

            invocations = [json.loads(line) for line in (root / "cursor-invocations.jsonl").read_text().splitlines()]
            help_invocation = next(invocation for invocation in invocations if "--help" in invocation["argv"])
            self.assertNotEqual(Path(help_invocation["cwd"]).resolve(), repo.resolve())
            self.assertEqual(help_invocation["environment"]["GIT_CONFIG_GLOBAL"], None)
            self.assertEqual(help_invocation["environment"]["NODE_OPTIONS"], None)
            self.assertEqual(help_invocation["environment"]["PYTHONPATH"], None)
            self.assertNotIn(str(repo), help_invocation["environment"]["PATH"].split(os.pathsep))


if __name__ == "__main__":
    unittest.main()

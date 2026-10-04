#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import contextlib
import copy
import hashlib
import importlib.util
import io
import itertools
import json
import os
import runpy
import stat
import subprocess
import sys
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path
from unittest import mock


SCRIPT_PATH = Path(__file__).with_name("autoreview")
fixture_git = runpy.run_path(str(SCRIPT_PATH.with_name("test-review-harness.py")))["fixture_git"]
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
    def test_parser_resource_errors_are_invalid_reports(self) -> None:
        args = argparse.Namespace(engine="codex", max_priority="P2")
        for raw in ("[" * 2000 + "]" * 2000, '{"findings":[],"number":' + "9" * 10000 + "}"):
            with self.subTest(length=len(raw)), mock.patch.object(
                AUTOREVIEW, "run_engine", return_value=raw,
            ):
                with self.assertRaises(AUTOREVIEW.ReviewerUnavailable) as caught:
                    AUTOREVIEW.run_reviewer(args, Path.cwd(), "synthetic", set(), [])
                self.assertEqual(caught.exception.reason, "invalid_report")

    def test_container_valued_report_enums_are_invalid_reports(self) -> None:
        args = argparse.Namespace(engine="codex", max_priority="P2")
        finding = copy.deepcopy(DRAFT_REPORT["findings"][0])
        finding["source_attribution"] = {
            "target": "index", "record_id": "record", "source_id": "source",
            "side": "present", "column": 1, "excerpt": "text",
        }
        for field in ("overall_correctness", "priority", "category", "target", "side"):
            for value in ([], {}, None, 42, False):
                report = copy.deepcopy(FINAL_REPORT)
                report["findings"] = [copy.deepcopy(finding)]
                owner = report if field == "overall_correctness" else report["findings"][0]
                if field in {"target", "side"}:
                    owner = owner["source_attribution"]
                owner[field] = value
                with self.subTest(field=field, value=value), mock.patch.object(
                    AUTOREVIEW, "run_engine", return_value=json.dumps({**report, "review_completion": "complete"}),
                ):
                    with self.assertRaises(AUTOREVIEW.ReviewerUnavailable) as caught:
                        AUTOREVIEW.run_reviewer(args, Path.cwd(), "synthetic", {"draft.js"}, [])
                    self.assertEqual(caught.exception.reason, "invalid_report")

    def test_private_completion_is_required_validated_and_stripped(self) -> None:
        args = argparse.Namespace(engine="codex", max_priority="P2")
        for completion in ("complete", "incomplete"):
            provider = {**FINAL_REPORT, "review_completion": completion}
            with self.subTest(completion=completion), mock.patch.object(
                AUTOREVIEW, "run_engine", return_value=json.dumps(provider),
            ):
                result = AUTOREVIEW.run_reviewer(args, Path.cwd(), "synthetic", set(), [])
            self.assertEqual(result.complete, completion == "complete")
            self.assertEqual(result.report["provider_report"], FINAL_REPORT)
            self.assertNotIn("review_completion", result.report)
            self.assertEqual(
                AUTOREVIEW.review_status(result.report, complete=result.complete),
                "scoped-clean" if result.complete else "incomplete",
            )
        for provider in (
            FINAL_REPORT,
            *({**FINAL_REPORT, "review_completion": value}
              for value in ("", "deferred", [], {}, None, 42, False)),
        ):
            with self.subTest(provider=provider), mock.patch.object(
                AUTOREVIEW, "run_engine", return_value=json.dumps(provider),
            ):
                with self.assertRaises(AUTOREVIEW.ReviewerUnavailable) as caught:
                    AUTOREVIEW.run_reviewer(args, Path.cwd(), "synthetic", set(), [])
            self.assertEqual(caught.exception.reason, "invalid_report")
            self.assertIn("missing or invalid review_completion", str(caught.exception))

    def test_provider_schema_keeps_completion_out_of_public_schema(self) -> None:
        self.assertEqual(
            AUTOREVIEW.PROVIDER_SCHEMA["required"],
            [*AUTOREVIEW.SCHEMA["required"], "review_completion"],
        )
        self.assertEqual(
            AUTOREVIEW.PROVIDER_SCHEMA["properties"]["review_completion"],
            {"type": "string", "enum": ["complete", "incomplete"]},
        )
        self.assertFalse(AUTOREVIEW.PROVIDER_SCHEMA["additionalProperties"])
        self.assertNotIn("review_completion", AUTOREVIEW.SCHEMA["properties"])
        prompt = AUTOREVIEW.render_review_prompt(
            "task", "local", None, AUTOREVIEW.ReviewChunk("change"), "", "", (1, 2),
        )
        self.assertIn(json.dumps(AUTOREVIEW.PROVIDER_SCHEMA), prompt)
        self.assertIn("independent, complete assignment", prompt)
        self.assertIn("no shared conversation or future evidence batch", prompt)

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


class AutoreviewImageEvidenceTests(unittest.TestCase):
    PNG = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
    )

    def test_supported_image_is_staged_with_exact_manifest_identity(self) -> None:
        digest = hashlib.sha256(self.PNG).hexdigest()
        image = AUTOREVIEW.ImageEvidence("assets/avatar.png", "image/png", digest, self.PNG)
        self.assertEqual(AUTOREVIEW.image_media_type(image.path, image.content), "image/png")
        manifest = AUTOREVIEW.image_manifest((image,))
        self.assertIn('path="assets/avatar.png"', manifest)
        self.assertIn(f"sha256={digest}", manifest)
        with tempfile.TemporaryDirectory() as tmpdir:
            paths = AUTOREVIEW.stage_review_images(Path(tmpdir), (image,))
            self.assertEqual(paths[0].read_bytes(), self.PNG)

    def test_oversized_dimensions_are_refused_before_pixel_decoding(self):
        from PIL import Image
        original_open = Image.open
        def declared_large(*args, **kwargs):
            image = original_open(*args, **kwargs)
            image._size = (8192, 8192)
            image.load = mock.Mock(side_effect=AssertionError("pixels must not be decoded"))
            return image
        with mock.patch.object(Image, "open", side_effect=declared_large):
            with self.assertRaisesRegex(SystemExit, "decoder limits"):
                AUTOREVIEW.image_media_type("large.png", self.PNG)

    def test_decompression_bomb_warning_is_a_refusal(self):
        from PIL import Image
        with mock.patch.object(Image, "MAX_IMAGE_PIXELS", 0.75):
            with self.assertRaisesRegex(SystemExit, "decoder limits"):
                AUTOREVIEW.image_media_type("warning.png", self.PNG)

    def test_missing_decoder_fails_closed(self):
        with mock.patch.dict(sys.modules, {"PIL": None}):
            with self.assertRaisesRegex(SystemExit, "requires Pillow"):
                AUTOREVIEW.image_media_type("image.png", self.PNG)

    def test_native_codex_command_attaches_images_before_stdin_separator(self):
        args = argparse.Namespace(codex_bin="codex", web_search=False,
            thinking="high", stream_engine_output=False, codex_config=None,
            codex_speed=None)
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(
            AUTOREVIEW, "resolve_command", return_value="/usr/bin/codex"
        ):
            root = Path(tmp)
            images = [root / "attachment-1.webp", root / "attachment-2.png"]
            command = AUTOREVIEW.codex_command(args, root, root, root,
                root / "schema.json", root / "output.json", "vision-model",
                auth_config=[], image_paths=images)
        self.assertEqual(command[-6:], ["--image", str(images[0]),
            "--image", str(images[1]), "--", "-"])
        self.assertIn("--ignore-user-config", command)
        self.assertIn("--ignore-rules", command)
        self.assertIn("features.plugins=false", command)

    def test_tampered_image_fails_closed_before_reviewer_launch(self) -> None:
        image = AUTOREVIEW.ImageEvidence(
            "assets/avatar.png", "image/png", "0" * 64, self.PNG,
        )
        with tempfile.TemporaryDirectory() as tmpdir, self.assertRaisesRegex(
            SystemExit, "captured image bytes changed"
        ):
            AUTOREVIEW.stage_review_images(Path(tmpdir), (image,))


class AutoreviewImageGitTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.repo = Path(self.tmp.name)
        self.git("init", "-q")
        self.git("config", "user.email", "test@example.invalid")
        self.git("config", "user.name", "Test")
        (self.repo / "text.txt").write_bytes(b"old\n")
        self.git("add", ".")
        self.git("commit", "-qm", "base")
        self.base = self.git("rev-parse", "HEAD").strip()

    def git(self, *args):
        return fixture_git(
            self.repo, *args, check=True, stdout=subprocess.PIPE, text=True,
        ).stdout

    def commit(self, path, content):
        file = self.repo / path
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_bytes(content)
        self.git("add", ".")
        self.git("commit", "-qm", "change")

    def test_branch_captures_commit_bytes_not_dirty_worktree(self):
        path = "assets/portrait.png"
        self.commit(path, AutoreviewImageEvidenceTests.PNG)
        (self.repo / path).write_bytes(b"dirty replacement")
        captured = AUTOREVIEW.branch_bundle(self.repo, self.base)
        self.assertEqual(captured.images[0].content, AutoreviewImageEvidenceTests.PNG)
        self.assertIn(path, captured.paths)
        self.assertIn("Binary files", captured.text)
        self.assertEqual(len(captured.images), 1)

    def test_image_capture_preserves_literal_paths_and_ignores_dirty_filters(self):
        path = "assets/[literal]\timage.png" if os.name != "nt" else "assets/[literal]image.png"
        self.commit(path, AutoreviewImageEvidenceTests.PNG)
        self.git("config", "filter.denied.clean", "exit 91")
        self.git("config", "filter.denied.required", "true")
        (self.repo / ".gitattributes").write_text("* filter=denied\n")
        (self.repo / path).write_bytes(b"uncommitted replacement")
        captured = AUTOREVIEW.branch_bundle(self.repo, self.base)
        self.assertEqual(captured.images[0].path, path)
        self.assertEqual(captured.images[0].content, AutoreviewImageEvidenceTests.PNG)
        self.assertEqual(captured.commit, self.git("rev-parse", "HEAD").strip())

    def test_encoded_image_budget_is_checked_before_blob_capture(self):
        self.commit("oversized.png", AutoreviewImageEvidenceTests.PNG)
        original = AUTOREVIEW.git_bytes
        def limited(repo, *args, **kwargs):
            if args[:2] == ("cat-file", "-s"):
                return subprocess.CompletedProcess(args, 0, b"20971521\n", b"")
            if args[:2] == ("cat-file", "blob"):
                raise AssertionError("oversized image bytes must not be captured")
            return original(repo, *args, **kwargs)
        with mock.patch.object(AUTOREVIEW, "git_bytes", side_effect=limited):
            with self.assertRaisesRegex(SystemExit, "encoded image"):
                AUTOREVIEW.branch_bundle(self.repo, self.base)

    def test_aggregate_image_budget_is_checked_before_next_blob(self):
        self.commit("first.png", AutoreviewImageEvidenceTests.PNG)
        self.commit("second.png", AutoreviewImageEvidenceTests.PNG)
        original = AUTOREVIEW.git_bytes
        reads = []
        def observe(repo, *args, **kwargs):
            if args[:2] == ("cat-file", "blob"):
                reads.append(args)
            return original(repo, *args, **kwargs)
        with mock.patch.object(AUTOREVIEW, "MAX_REVIEW_IMAGE_TOTAL_BYTES", len(AutoreviewImageEvidenceTests.PNG), create=True), \
                mock.patch.object(AUTOREVIEW, "git_bytes", side_effect=observe):
            with self.assertRaisesRegex(SystemExit, "encoded image"):
                AUTOREVIEW.branch_bundle(self.repo, self.base)
        self.assertEqual(len(reads), 1)

    def test_unsupported_binary_and_spoofed_extension_are_rejected(self):
        for name, data in [("payload.bin", b"\x00opaque"),
                           ("fake.png", b"\x89PNG\r\n\x1a\n\x00truncated")]:
            with self.subTest(name=name):
                self.git("reset", "--hard", self.base)
                self.commit(name, data)
                with self.assertRaisesRegex(SystemExit, "unsupported or malformed"):
                    AUTOREVIEW.branch_bundle(self.repo, self.base)

    def test_attributes_cannot_hide_opaque_blobs_or_image_attachments(self):
        self.commit(".gitattributes", "* diff\n".encode())
        self.commit("hidden.bin", b"opaque\0payload")
        with self.assertRaisesRegex(SystemExit, "unsupported or malformed"):
            AUTOREVIEW.branch_bundle(self.repo, self.base)
        self.git("rm", "hidden.bin")
        self.git("commit", "-qm", "remove opaque")
        self.commit("portrait.png", AutoreviewImageEvidenceTests.PNG)
        # Forced textual image patches must never be lossily decoded or
        # silently reviewed without pixels. The existing UTF-8 gate refuses.
        with self.assertRaisesRegex(SystemExit, "non-UTF-8 Git output"):
            AUTOREVIEW.branch_bundle(self.repo, self.base)

    def test_modified_images_refuse_but_deletions_keep_only_metadata(self):
        self.commit("portrait.png", AutoreviewImageEvidenceTests.PNG)
        base = self.git("rev-parse", "HEAD").strip()
        self.commit("portrait.png", AutoreviewImageEvidenceTests.PNG + b"x")
        with self.assertRaisesRegex(SystemExit, "only added images"):
            AUTOREVIEW.branch_bundle(self.repo, base)
        self.git("rm", "portrait.png")
        self.git("commit", "-qm", "delete")
        with mock.patch.object(AUTOREVIEW, "image_media_type", side_effect=AssertionError("decoded deletion")):
            captured = AUTOREVIEW.branch_bundle(self.repo, base)
        self.assertEqual(captured.images, ())
        self.assertIn("portrait.png", captured.paths)
        self.assertIn("Binary files ", captured.text)

    def test_sensitive_images_are_not_attached(self):
        self.commit(".ssh/portrait.png", AutoreviewImageEvidenceTests.PNG)
        with self.assertRaisesRegex(SystemExit, "sensitive binary"):
            AUTOREVIEW.branch_bundle(self.repo, self.base)

    def test_local_and_commit_modes_still_fail_closed(self):
        self.commit("portrait.png", AutoreviewImageEvidenceTests.PNG)
        with self.assertRaisesRegex(SystemExit, "refusing binary changes"):
            AUTOREVIEW.commit_bundle(self.repo, "HEAD")
        (self.repo / "portrait.png").write_bytes(AutoreviewImageEvidenceTests.PNG + b"x")
        with self.assertRaisesRegex(SystemExit, "refusing binary changes"):
            AUTOREVIEW.local_bundle(self.repo)

    def test_other_engine_cannot_get_clean_image_verdict(self):
        self.commit("portrait.png", AutoreviewImageEvidenceTests.PNG)
        captured = AUTOREVIEW.branch_bundle(self.repo, self.base)
        for engine in ("claude", "amp", "pi", "kimi"):
            with self.subTest(engine=engine), mock.patch.object(AUTOREVIEW, "run_engine") as run:
                with self.assertRaisesRegex(SystemExit, "only by the Codex"):
                    AUTOREVIEW.run_reviewer(argparse.Namespace(engine=engine), self.repo, "review", captured, [])
                run.assert_not_called()

    def test_manifest_and_attachments_travel_on_every_pass(self):
        self.commit("portrait.png", AutoreviewImageEvidenceTests.PNG)
        captured = AUTOREVIEW.branch_bundle(self.repo, self.base)
        with mock.patch.object(AUTOREVIEW, "build_review_prompts", return_value=["one", "two"]) as build:
            AUTOREVIEW.prepare_review_prompts(self.repo, "branch", self.base, captured, "instructions", [], 512000)
        self.assertIn(captured.images[0].sha256, build.call_args.args[4])
        args = argparse.Namespace(engine="codex", max_priority="P0")
        with mock.patch.object(AUTOREVIEW, "run_engine", return_value=json.dumps({**FINAL_REPORT, "review_completion": "complete"})) as run:
            AUTOREVIEW.run_review_passes(args, [args], self.repo, ["one", "two"], captured)
        self.assertEqual(run.call_count, 2)
        for call in run.call_args_list:
            self.assertEqual(call.args[0].review_images, captured.images)
            self.assertIs(call.args[0].review_usage, args.review_usage)
        self.assertFalse(hasattr(args, "review_images"))

    def test_valid_webp_jpeg_and_png_decode_but_animation_does_not(self):
        from PIL import Image
        for fmt, suffix in [("WEBP", "webp"), ("JPEG", "jpg"), ("PNG", "png")]:
            out = io.BytesIO()
            Image.new("RGB", (4, 4), "red").save(out, format=fmt)
            self.assertIsNotNone(AUTOREVIEW.image_media_type("image." + suffix, out.getvalue()))
        out = io.BytesIO()
        Image.new("RGB", (4, 4), "red").save(out, format="WEBP", save_all=True,
            append_images=[Image.new("RGB", (4, 4), "blue")], duration=100)
        with self.assertRaisesRegex(SystemExit, "animated"):
            AUTOREVIEW.image_media_type("image.webp", out.getvalue())


class AutoreviewPriorityTests(unittest.TestCase):
    def test_default_priority_is_p0(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(sys, "argv", ["autoreview"]):
            args = AUTOREVIEW.parse_args()
        self.assertEqual(args.max_priority, "P0")

    def test_priority_environment_values_and_explicit_overrides(self) -> None:
        for priority in ("P0", "P1", "P2", "P3"):
            for env_priority, options in (
                (priority, []),
                ("P4", ["--max-priority", priority]),
                ("", ["--max-priority", priority]),
            ):
                with self.subTest(priority=priority, env=env_priority), mock.patch.dict(
                    os.environ, {"AUTOREVIEW_MAX_PRIORITY": env_priority}, clear=True,
                ), mock.patch.object(sys, "argv", ["autoreview", *options]):
                    self.assertEqual(AUTOREVIEW.parse_args().max_priority, priority)

    def test_invalid_priority_defaults_refuse_before_preparation(self) -> None:
        for priority in ("P4", "", " ", "p2"):
            for dry_run in (False, True):
                with self.subTest(priority=priority, dry_run=dry_run), tempfile.TemporaryDirectory() as tmp:
                    status = Path(tmp) / "status.json"
                    status.write_text("existing status\n")
                    activity = {
                        name: mock.Mock(side_effect=AssertionError(f"unexpected {name}"))
                        for name in (
                            "EngineStage", "persist_engine_stage", "reviewer_args", "preflight_git",
                            "prepare_output_paths", "run_engine",
                        )
                    }
                    argv = [
                        "autoreview", "--status-output", str(status), "--stream-engine-output",
                        "--engine-stage-dir", str(Path(tmp) / "stage"),
                        *(["--dry-run"] if dry_run else []),
                    ]
                    stderr = io.StringIO()
                    with mock.patch.dict(os.environ, {"AUTOREVIEW_MAX_PRIORITY": priority}, clear=True), \
                            mock.patch.object(sys, "argv", argv), \
                            mock.patch.multiple(AUTOREVIEW, **activity), contextlib.redirect_stderr(stderr):
                        with self.assertRaises(SystemExit) as caught:
                            AUTOREVIEW.main_impl()
                    self.assertEqual(caught.exception.code, 2)
                    self.assertIn("invalid --max-priority/AUTOREVIEW_MAX_PRIORITY", stderr.getvalue())
                    for call in activity.values():
                        call.assert_not_called()
                    self.assertEqual(status.read_text(), "existing status\n")
                    self.assertEqual(sorted(item.name for item in Path(tmp).iterdir()), ["status.json"])

    def test_priority_help_ignores_invalid_environment_default(self) -> None:
        with mock.patch.dict(os.environ, {"AUTOREVIEW_MAX_PRIORITY": "P4"}, clear=True), \
                mock.patch.object(sys, "argv", ["autoreview", "--help"]), \
                contextlib.redirect_stdout(io.StringIO()) as stdout:
            with self.assertRaises(SystemExit) as caught:
                AUTOREVIEW.parse_args()
        self.assertEqual(caught.exception.code, 0)
        self.assertIn("--max-priority {P0,P1,P2,P3}", stdout.getvalue())

    def test_priority_filter_preserves_lower_findings_and_provider_verdict(self) -> None:
        report = copy.deepcopy(DRAFT_REPORT)
        AUTOREVIEW.filter_findings_by_priority(report, "P0")
        self.assertEqual(report["findings"], [])
        self.assertEqual(report["priority_filtered_findings"], DRAFT_REPORT["findings"])
        for key in ("overall_correctness", "overall_explanation", "overall_confidence"):
            self.assertEqual(report[key], DRAFT_REPORT[key])

    def test_unfinished_assessment_keeps_filtered_observations_incomplete(self) -> None:
        args = argparse.Namespace(engine="codex", max_priority="P0")
        with mock.patch.object(
            AUTOREVIEW, "run_engine",
            return_value=json.dumps({**DRAFT_REPORT, "review_completion": "incomplete"}),
        ):
            result = AUTOREVIEW.run_reviewer(args, Path.cwd(), "synthetic", {"draft.js"}, [])
        self.assertFalse(result.complete)
        self.assertEqual(result.report["provider_report"], DRAFT_REPORT)
        self.assertEqual(result.report["findings"], [])
        self.assertEqual(result.report["priority_filtered_findings"], DRAFT_REPORT["findings"])
        self.assertEqual(AUTOREVIEW.review_status(result.report, complete=result.complete), "incomplete")


class AutoreviewResultScopeTests(unittest.TestCase):
    def test_scope_rejection_preserves_provider_conclusion_and_audit(self) -> None:
        report = copy.deepcopy(DRAFT_REPORT)
        with contextlib.redirect_stderr(io.StringIO()):
            AUTOREVIEW.validate_report(report, Path.cwd(), {"changed.js"}, [])
        self.assertEqual(report["findings"], [])
        for key in ("overall_correctness", "overall_explanation", "overall_confidence"):
            self.assertEqual(report[key], DRAFT_REPORT[key])
        self.assertEqual(report["scope_rejected_findings"], DRAFT_REPORT["findings"])
        report["review_status"] = AUTOREVIEW.review_status(report, complete=True)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            AUTOREVIEW.print_report(report)
        self.assertIn("incomplete", output.getvalue())
        self.assertIn("Draft finding", output.getvalue())
        self.assertIn("draft.js:1", output.getvalue())
        self.assertNotIn("clean:", output.getvalue())

    def test_chunk_merge_keeps_rejections_explanations_and_conservative_confidence(self) -> None:
        rejected = copy.deepcopy(DRAFT_REPORT)
        with contextlib.redirect_stderr(io.StringIO()):
            AUTOREVIEW.validate_report(rejected, Path.cwd(), {"changed.js"}, [])
        reports = [("chunk 1/2", copy.deepcopy(FINAL_REPORT)), ("chunk 2/2", rejected)]
        merged = AUTOREVIEW.merge_chunk_reports(reports)
        self.assertEqual(merged["overall_correctness"], "patch is incorrect")
        self.assertEqual(merged["overall_confidence"], 0.2)
        self.assertEqual(len(merged["scope_rejected_findings"]), 1)
        self.assertEqual(merged["pass_reports"][1]["report"], rejected)
        merged["review_status"] = AUTOREVIEW.review_status(merged, complete=True)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            AUTOREVIEW.print_report(merged)
        self.assertIn("draft", output.getvalue())
        self.assertIn("incomplete", output.getvalue())
        self.assertNotIn("clean:", output.getvalue())

    def test_required_finding_must_survive_priority_filter_for_every_pass_count(self) -> None:
        args = argparse.Namespace(engine="codex", max_priority="P0", require_finding=["Draft finding"])
        for count in (1, 2):
            with self.subTest(count=count), mock.patch.object(
                AUTOREVIEW, "run_engine", return_value=json.dumps({**DRAFT_REPORT, "review_completion": "complete"}),
            ):
                results = AUTOREVIEW.run_review_passes(
                    args, [args], Path.cwd(), ["pack"] * count, {"draft.js"}
                )
            self.assertTrue(all(result.complete for _, result in results))
            reports = [(label, result.report) for label, result in results]
            report = reports[0][1] if count == 1 else AUTOREVIEW.merge_chunk_reports(reports)
            self.assertEqual(
                AUTOREVIEW.missing_required_findings(report, args.require_finding), ["Draft finding"]
            )
            self.assertEqual(report["overall_correctness"], "patch is incorrect")
            self.assertTrue(report["priority_filtered_findings"])

    def test_provider_cannot_supply_local_audit_metadata(self) -> None:
        for key in ("scope_rejected_findings", "priority_filtered_findings", "pass_reports", "review_status", "review_completion"):
            report = copy.deepcopy(FINAL_REPORT)
            report[key] = []
            with self.subTest(key=key), self.assertRaisesRegex(SystemExit, "unexpected top-level"):
                AUTOREVIEW.validate_report(report, Path.cwd(), set(), [])

    def test_required_finding_survives_merge_deduplication_and_body_prefix(self) -> None:
        first = copy.deepcopy(DRAFT_REPORT)
        second = copy.deepcopy(DRAFT_REPORT)
        second["findings"][0]["body"] = "x" * 1980 + " required tail"
        merged = AUTOREVIEW.merge_chunk_reports([("chunk 1/2", first), ("chunk 2/2", second)])
        self.assertEqual(len(merged["findings"]), 1)
        self.assertEqual(AUTOREVIEW.missing_required_findings(merged, ["required tail"]), [])


class AutoreviewTargetResultTests(unittest.TestCase):
    def setUp(self):
        source = AUTOREVIEW.SourceVersion
        self.record = AUTOREVIEW.MixedPath(
            "src/migrate.py", "synthetic-record",
            source("base-source", "100644", "original()\nkeep()\n"),
            source("index-source", "100644", "obsolete()\nkeep()\n"),
            source("working-source", "100644", "corrected()\nkeep()\nbroken()\n"),
            "synthetic staged delta", "synthetic unstaged delta",
            ((1, "original()"),), ((1, "obsolete()"),), (),
        )

    def finding(self, target="index", side="present", line=1, excerpt=None, **changes):
        source = ((self.record.base if target == "index" else self.record.index)
                  if side == "removed" else getattr(self.record, target))
        if excerpt is None:
            excerpt = source.content.splitlines()[line - 1]
        finding = {
            "title": "Synthetic defect", "body": "A concrete synthetic claim.",
            "priority": "P0", "confidence": 0.8, "category": "bug",
            "code_location": {"file_path": self.record.path, "line": line},
            "source_attribution": {"target": target, "record_id": self.record.identity,
                                   "source_id": source.identity, "side": side,
                                   "column": 1, "excerpt": excerpt},
        }
        finding.update(changes)
        return finding

    def validate(self, findings, available=True):
        report = copy.deepcopy(FINAL_REPORT)
        report["findings"] = copy.deepcopy(findings)
        AUTOREVIEW.validate_report(report, Path.cwd(), {self.record.path}, [], (self.record,),
                                   {self.record.identity} if available else set())
        return report

    def test_explicit_targets_anchors_and_pass_availability(self):
        accepted = [self.finding(), self.finding("working_tree", line=3),
                    self.finding("working_tree", line=2), self.finding(side="removed"),
                    self.finding("working_tree", side="removed")]
        self.assertEqual(self.validate(accepted)["findings"], accepted)
        cases = []
        missing = self.finding()
        missing.pop("source_attribution")
        cases.append((missing, "requires explicit"))
        null = self.finding(source_attribution=None)
        cases.append((null, "requires explicit"))
        for field, value, reason in (
            ("record_id", "wrong", "record identity"),
            ("source_id", "wrong", "source identity"),
            ("column", 1000, "excerpt"),
            ("excerpt", "invented()", "excerpt"),
        ):
            finding = self.finding()
            finding["source_attribution"][field] = value
            cases.append((finding, reason))
        cases.extend([
            (self.finding("working_tree", excerpt="obsolete()"), "excerpt"),
            (self.finding("working_tree", line=900, excerpt="broken()"), "out of range"),
            (self.finding("working_tree", side="removed", line=2), "genuinely removed"),
        ])
        for finding, reason in cases:
            with self.subTest(reason=reason, finding=finding):
                report = self.validate([finding])
                self.assertEqual(report["findings"], [])
                self.assertIn(reason, report["attribution_rejected_findings"][0]["attribution_rejection_reason"])
                self.assertEqual(AUTOREVIEW.review_status(report, complete=True), "incomplete")
                self.assertEqual(report["overall_correctness"], "patch is correct")
        report = self.validate([self.finding()], available=False)
        self.assertIn("not available", report["attribution_rejected_findings"][0]["attribution_rejection_reason"])
        original = self.record
        for path in (" src/migrate.py", "src/migrate.py ", " "):
            with self.subTest(path=path):
                self.record = original._replace(path=path)
                finding = self.finding()
                self.assertEqual(self.validate([finding])["findings"], [finding])
            self.record = original

    def test_absence_readd_and_removed_side_are_distinct(self):
        absent = AUTOREVIEW.SourceVersion("absent", None, None)
        for target in ("index", "working_tree"):
            with self.subTest(target=target):
                original = self.record
                if target == "index":
                    self.record = original._replace(index=absent, working_tree_removed=())
                else:
                    self.record = original._replace(working_tree=absent)
                present = self.finding(target, excerpt="obsolete()")
                removed = self.finding(target, side="removed")
                report = self.validate([present, removed])
                self.assertEqual(report["findings"], [removed])
                self.assertIn("absent", report["attribution_rejected_findings"][0]["attribution_rejection_reason"])
                self.record = original

        original = self.record
        for target, side, content, line in (
            ("index", "present", "", 1), ("working_tree", "present", "", 1),
            ("index", "present", "before()\n\n", 2), ("working_tree", "present", "before()\n\n", 2),
            ("index", "removed", "\n", 1), ("working_tree", "removed", "\n", 1),
        ):
            with self.subTest(target=target, side=side, content=content):
                owner = ("base" if target == "index" else "index") if side == "removed" else target
                self.record = original._replace(**{owner: getattr(original, owner)._replace(content=content)})
                if side == "removed":
                    self.record = self.record._replace(**{target + "_removed": ((line, ""),)})
                valid = self.finding(target, side=side, line=line, excerpt="")
                self.assertEqual(self.validate([valid])["findings"], [valid])
                invalid = []
                for key, value in (("record_id", "wrong"), ("source_id", "wrong"),
                                   ("column", 2), ("excerpt", "invented")):
                    bad = copy.deepcopy(valid)
                    bad["source_attribution"][key] = value
                    invalid.append(bad)
                bad = copy.deepcopy(valid)
                bad["code_location"]["line"] = 2 if not content else 900
                invalid.append(bad)
                if side == "present" and content:
                    bad = copy.deepcopy(valid)
                    bad["code_location"]["line"] = 1
                    invalid.append(bad)
                for bad in invalid:
                    report = self.validate([bad])
                    self.assertEqual(report["findings"], [])
                    self.assertEqual(AUTOREVIEW.review_status(report, complete=True), "incomplete")
                self.record = original
        for target in ("index", "working_tree"):
            for side in ("present", "removed"):
                report = self.validate([self.finding(target, side=side, excerpt="")])
                self.assertEqual(report["findings"], [])
            self.record = original._replace(**{target: absent})
            report = self.validate([self.finding(target, excerpt="")])
            self.assertIn("absent", report["attribution_rejected_findings"][0]["attribution_rejection_reason"])
            self.record = original

    def test_title_independent_groups_keep_variants_targets_and_observations(self):
        reports = []
        for index in range(8):
            finding = self.finding(title=f"Index title {index}")
            findings = [finding]
            if index == 7:
                findings += [self.finding(body="Distinct consequence requiring a different fix."),
                             self.finding("working_tree")]
            reports.append((f"pass {index}", self.validate(findings)))
        for selected in (reports, [("single", self.validate([
            finding for _, report in reports for finding in report["findings"]
        ]))]):
            with self.subTest(passes=len(selected)):
                result = AUTOREVIEW.merge_chunk_reports(selected)
                self.assertEqual(len(result["findings"]), 2)
                grouped = result["findings"][0]
                self.assertEqual(len(grouped["claim_variants"]), 2)
                self.assertEqual(len(grouped["claim_variants"][0]["observations"]), 8)
                self.assertEqual(AUTOREVIEW.missing_required_findings(result, ["Index title 7", "different fix"]), [])
                self.assertEqual(len(result["pass_reports"]), len(selected))
                result["review_status"] = AUTOREVIEW.review_status(result, complete=True)
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    AUTOREVIEW.print_report(result)
                for text in ("INDEX-only", "WORKING_TREE", "Index title 7", "different fix"):
                    self.assertIn(text, output.getvalue())

    def test_all_engines_keep_raw_reports_before_normalization_and_filters(self):
        captured = AUTOREVIEW.CapturedBundle("delta", {self.record.path}, (self.record,), ())
        prompt = AUTOREVIEW.ReviewPass("synthetic pack", AUTOREVIEW.ReviewChunk("delta", sources=(self.record,)))
        valid = self.finding()
        valid["code_location"]["file_path"] = r".\src\migrate.py"
        stale = self.finding("working_tree", excerpt="obsolete()")
        outside = self.finding(code_location={"file_path": "outside.py", "line": 1})
        provider = {**FINAL_REPORT, "findings": [valid, stale, outside],
                    "overall_correctness": "patch is incorrect", "overall_confidence": 0.43}
        for engine in ("codex", "claude", "amp", "pi"):
            with self.subTest(engine=engine), mock.patch.object(
                    AUTOREVIEW, "run_engine", return_value=json.dumps({**provider, "review_completion": "complete"})), \
                    mock.patch.object(AUTOREVIEW, "verify_mixed_sources"), contextlib.redirect_stderr(io.StringIO()):
                result = AUTOREVIEW.run_reviewer(argparse.Namespace(engine=engine, max_priority="P0"),
                                                 Path.cwd(), prompt, captured, [])
            self.assertTrue(result.complete)
            report = result.report
            self.assertEqual(report["provider_report"], provider)
            self.assertEqual(report["overall_confidence"], 0.43)
            self.assertEqual(len(report["findings"]), 1)
            self.assertEqual(len(report["scope_rejected_findings"]), 1)
            self.assertEqual(len(report["attribution_rejected_findings"]), 1)
            self.assertEqual(AUTOREVIEW.review_status(report, complete=result.complete), "incomplete")
            self.assertEqual(report["available_source_records"], [self.record.identity])
        low = self.validate([self.finding(priority="P2")])
        AUTOREVIEW.filter_findings_by_priority(low, "P0")
        self.assertEqual(AUTOREVIEW.missing_required_findings(low, ["Synthetic defect"]), ["Synthetic defect"])
        self.assertEqual(AUTOREVIEW.review_status(low, complete=True), "filtered")
        for bad in ({}, {**self.finding()["source_attribution"], "column": True}):
            with self.assertRaisesRegex(SystemExit, "source_attribution"):
                self.validate([self.finding(source_attribution=bad)])

def amp_test_stream(
    cwd: Path,
    *,
    tools: list[object] | None = None,
    mcp_servers: list[object] | None = None,
    trigger: str = "Run the isolated autoreview adapter.",
    tool_name: str = "autoreview_generate",
    tool_input: object = None,
    tool_result_id: str = "amp-tool-use",
    tool_error: bool = False,
    tool_result_content: str | None = None,
    final_text: str = "Completed.",
    ensure_ascii: bool = True,
) -> str:
    if tool_input is None:
        tool_input = {}
    if tool_result_content is None:
        tool_result_content = (
            "Autoreview generation failed." if tool_error else "Adapter completed."
        )
    return "\n".join(
        [
            json.dumps(
                {
                    "type": "system",
                    "subtype": "init",
                    "cwd": str(cwd),
                    "session_id": "amp-test-session",
                    "tools": ["autoreview_generate"] if tools is None else tools,
                    "mcp_servers": [] if mcp_servers is None else mcp_servers,
                    "agent_mode": "medium",
                },
                ensure_ascii=ensure_ascii,
            ),
            json.dumps(
                {
                    "type": "user",
                    "message": {
                        "role": "user",
                        "content": [{"type": "text", "text": trigger}],
                    },
                    "parent_tool_use_id": None,
                    "session_id": "amp-test-session",
                },
                ensure_ascii=ensure_ascii,
            ),
            json.dumps(
                {
                    "type": "assistant",
                    "message": {
                        "role": "assistant",
                        "content": [
                            {
                                "type": "tool_use",
                                "id": "amp-tool-use",
                                "name": tool_name,
                                "input": tool_input,
                            }
                        ],
                    },
                    "parent_tool_use_id": None,
                    "session_id": "amp-test-session",
                },
                ensure_ascii=ensure_ascii,
            ),
            json.dumps(
                {
                    "type": "user",
                    "message": {
                        "role": "user",
                        "content": [
                            {
                                "type": "tool_result",
                                "tool_use_id": tool_result_id,
                                "content": tool_result_content,
                                "is_error": tool_error,
                            }
                        ],
                    },
                    "parent_tool_use_id": None,
                    "session_id": "amp-test-session",
                },
                ensure_ascii=ensure_ascii,
            ),
            json.dumps(
                {
                    "type": "assistant",
                    "message": {
                        "role": "assistant",
                        "content": [{"type": "text", "text": final_text}],
                    },
                    "parent_tool_use_id": None,
                    "session_id": "amp-test-session",
                },
                ensure_ascii=ensure_ascii,
            ),
            json.dumps(
                {
                    "type": "result",
                    "subtype": "success",
                    "is_error": False,
                    "result": final_text,
                    "session_id": "amp-test-session",
                },
                ensure_ascii=ensure_ascii,
            ),
        ]
    ) + "\n"


def amp_test_plugin_list(plugin_path: Path) -> str:
    return "\n".join(
        [
            f"✓ {plugin_path} active",
            "  tool: autoreview_generate",
            "  agent: autoreview-adapter",
            "  agent mode: autoreview",
        ]
    ) + "\n"


def amp_test_mcp_denial_result(
    command: list[str],
    env: dict[str, str],
) -> subprocess.CompletedProcess[str]:
    skills_root = Path(env["HOME"]) / ".config" / "agents" / "skills"
    probe_roots = list(skills_root.glob("autoreview-mcp-deny-*"))
    if len(probe_roots) != 1:
        raise AssertionError(f"expected one MCP denial probe, found {probe_roots}")
    mcp_config = json.loads((probe_roots[0] / "mcp.json").read_text(encoding="utf-8"))
    probe_name = next(iter(mcp_config))
    return subprocess.CompletedProcess(
        command,
        0,
        "12 tools available\n",
        f"error connecting to {probe_name}: MCP server is not allowed by MCP permissions\n",
    )


class AutoreviewAmpTests(unittest.TestCase):
    def test_amp_dry_run_and_runtime_reject_the_same_model_grammar(self) -> None:
        for model, diagnostic in (
            (None, "amp engine requires a model"),
            ("", "amp engine requires a model"),
            ("synthetic-model", "amp engine model must use a supported provider/model format"),
            ("unsupported/synthetic-model", "amp engine model must use a supported provider/model format"),
        ):
            args = argparse.Namespace(engine="amp", amp_bin="amp", model=model, thinking="high")
            with self.subTest(model=model), mock.patch.object(
                AUTOREVIEW, "find_command", return_value="/usr/bin/amp",
            ), mock.patch.dict(AUTOREVIEW.ENGINE_ISOLATION_PROBES, {
                "amp": lambda *_args: "/usr/bin/amp",
            }), mock.patch.object(
                AUTOREVIEW, "ensure_amp_isolation_supported", return_value="/usr/bin/amp",
            ), mock.patch.object(AUTOREVIEW, "safe_temp_root") as staging:
                self.assertEqual(AUTOREVIEW.resolve_engine_binary(args, Path.cwd()), (False, diagnostic))
                with self.assertRaises(SystemExit) as caught:
                    AUTOREVIEW.run_amp(args, Path.cwd(), "synthetic prompt")
                self.assertEqual(str(caught.exception.code), diagnostic)
                staging.assert_not_called()

    def test_amp_dry_run_validates_the_resolved_model_without_changing_precedence(self) -> None:
        valid, invalid = "openai/synthetic-model", "synthetic-model"
        cases = (
            ({}, [], "openai/gpt-5.6-sol", True),
            ({}, ["--model", valid], valid, True),
            ({}, ["--model", invalid], invalid, False),
            ({"AUTOREVIEW_MODEL": invalid}, [], invalid, False),
            ({"AUTOREVIEW_AMP_MODEL": invalid}, [], invalid, False),
            ({"AUTOREVIEW_MODEL": invalid, "AUTOREVIEW_AMP_MODEL": valid}, [], valid, True),
            ({"AUTOREVIEW_AMP_MODEL": invalid}, ["--model", valid], valid, True),
            ({"AUTOREVIEW_AMP_MODEL": valid}, ["--model", invalid], invalid, False),
            ({}, ["--model", invalid, "--model", "amp=" + valid], valid, True),
        )
        for env, options, expected_model, available in cases:
            with self.subTest(env=env, options=options), mock.patch.dict(os.environ, env, clear=True), \
                    mock.patch.object(sys, "argv", ["autoreview", "--engine", "amp", "--dry-run", *options]), \
                    mock.patch.object(AUTOREVIEW, "find_command", return_value="/usr/bin/amp"), \
                    mock.patch.dict(AUTOREVIEW.ENGINE_ISOLATION_PROBES, {"amp": lambda *_args: "/usr/bin/amp"}):
                reviewer = AUTOREVIEW.reviewer_args(AUTOREVIEW.parse_args())[0]
                self.assertEqual(reviewer.model, expected_model)
                expected_error = None if available else "amp engine model must use a supported provider/model format"
                self.assertEqual(AUTOREVIEW.resolve_engine_binary(reviewer, Path.cwd()), (available, expected_error))

    def test_amp_bin_cli_option_and_defaults(self) -> None:
        with mock.patch.object(
            sys,
            "argv",
            ["autoreview", "--engine", "amp", "--amp-bin", "/tmp/trusted-amp"],
        ):
            args = AUTOREVIEW.parse_args()
        reviewer = AUTOREVIEW.reviewer_args(args)[0]
        self.assertEqual(reviewer.amp_bin, "/tmp/trusted-amp")
        self.assertEqual(reviewer.model, "openai/gpt-5.6-sol")
        self.assertEqual(reviewer.thinking, "high")
        self.assertFalse(reviewer.tools)

    @unittest.skipIf(os.name == "nt", "Amp runtime is unsupported on native Windows")
    def test_amp_isolation_probe_requires_api_key_and_flags(self) -> None:
        args = argparse.Namespace(amp_bin="amp")
        required_flags = " ".join(
            [
                "--execute",
                "--stream-json",
                "--stream-json-input",
                "--plugin-ready-timeout",
                "--settings-file",
                "--no-ide",
            ]
        )
        with tempfile.TemporaryDirectory(prefix="autoreview-amp-probe-test.") as tmpdir, mock.patch.dict(
            os.environ,
            {"AMP_API_KEY": "test-key"},
            clear=False,
        ), mock.patch.object(
            AUTOREVIEW,
            "resolve_command",
            return_value="/usr/bin/amp",
        ), mock.patch.object(
            AUTOREVIEW,
            "safe_engine_env",
            return_value={},
        ), mock.patch.object(
            AUTOREVIEW,
            "safe_temp_root",
            return_value=Path(tmpdir),
        ), mock.patch.object(
            AUTOREVIEW,
            "run",
            return_value=subprocess.CompletedProcess(["amp", "--help"], 0, required_flags, ""),
        ):
            self.assertEqual(
                AUTOREVIEW.ensure_amp_isolation_supported(args, Path(tmpdir)),
                "/usr/bin/amp",
            )

        with mock.patch.dict(os.environ, {"AMP_API_KEY": ""}, clear=False), mock.patch.object(
            AUTOREVIEW,
            "resolve_command",
            return_value="/usr/bin/amp",
        ):
            with self.assertRaisesRegex(SystemExit, "requires AMP_API_KEY"):
                AUTOREVIEW.ensure_amp_isolation_supported(args, Path("/tmp/repo"))

    def test_amp_isolation_probe_rejects_native_windows(self) -> None:
        args = argparse.Namespace(amp_bin="amp")
        repo = Path("/tmp/repo")
        context = (
            contextlib.nullcontext()
            if os.name == "nt"
            else mock.patch.object(AUTOREVIEW.os, "name", "nt")
        )
        with context:
            with self.assertRaisesRegex(SystemExit, "native Windows"):
                AUTOREVIEW.ensure_amp_isolation_supported(args, repo)

    @unittest.skipIf(os.name == "nt", "Amp runtime is unsupported on native Windows")
    def test_amp_run_keeps_review_prompt_out_of_outer_agent(self) -> None:
        args = argparse.Namespace(
            amp_bin="amp",
            max_output_chars=2_000_000,
            model="openai/gpt-5.6-sol",
            stream_engine_output=False,
            thinking="high",
        )
        secret_prompt = "review diff PRIVATE_REVIEW_MARKER_8f3c"
        observed: dict[str, object] = {}

        def fake_preflight(
            command: list[str],
            cwd: Path,
            **kwargs: object,
        ) -> subprocess.CompletedProcess[str]:
            env = kwargs["env"]
            assert isinstance(env, dict)
            runtime_root = Path(str(env["XDG_CONFIG_HOME"])).parent
            plugin_root = Path(str(env["XDG_CONFIG_HOME"])) / "amp" / "plugins"
            plugin_path = next(plugin_root.glob("autoreview-*.ts"))
            if command[-2:] == ["tools", "list"]:
                observed["mcp_preflight_prompt_exists"] = (
                    runtime_root / "review-prompt.txt"
                ).exists()
                return amp_test_mcp_denial_result(command, env)
            observed["preflight_command"] = command
            observed["preflight_prompt_exists"] = (
                runtime_root / "review-prompt.txt"
            ).exists()
            return subprocess.CompletedProcess(
                command,
                0,
                amp_test_plugin_list(plugin_path),
                "",
            )

        def fake_execute(
            command: list[str],
            cwd: Path,
            **kwargs: object,
        ) -> subprocess.CompletedProcess[str]:
            observed["command"] = command
            observed["cwd"] = cwd
            observed["input"] = kwargs["input_text"]
            observed["env"] = kwargs["env"]
            env = kwargs["env"]
            assert isinstance(env, dict)
            runtime_root = Path(str(env["XDG_CONFIG_HOME"])).parent
            prompt_path = runtime_root / "review-prompt.txt"
            result_path = runtime_root / "review-result.json"
            settings_path = runtime_root / "settings.json"
            plugin_root = Path(str(env["XDG_CONFIG_HOME"])) / "amp" / "plugins"
            plugin_path = next(plugin_root.glob("autoreview-*.ts"))
            observed["prompt"] = prompt_path.read_text(encoding="utf-8")
            observed["settings"] = json.loads(settings_path.read_text(encoding="utf-8"))
            observed["plugin"] = plugin_path.read_text(encoding="utf-8")
            observed["plugin_path"] = plugin_path
            observed["workspace"] = list(cwd.iterdir())
            result_path.write_text(json.dumps(FINAL_REPORT), encoding="utf-8")
            result_path.chmod(0o600)
            return subprocess.CompletedProcess(command, 0, amp_test_stream(cwd), "")

        inherited = {
            "AMP_API_KEY": "test-key",
            "AMP_URL": "https://attacker.invalid",
            "NODE_OPTIONS": "--require=/tmp/attack.js",
            "PYTHONPATH": "/tmp/attack",
            "PLUGINS": "inherited-plugins",
        }
        with tempfile.TemporaryDirectory(prefix="autoreview-amp-run-test.") as tmpdir:
            repo = Path(tmpdir) / "repo"
            repo.mkdir()
            with mock.patch.dict(os.environ, inherited, clear=False), mock.patch.object(
                AUTOREVIEW,
                "ensure_amp_isolation_supported",
                return_value="/usr/bin/amp",
            ), mock.patch.object(
                AUTOREVIEW,
                "run",
                side_effect=fake_preflight,
            ), mock.patch.object(
                AUTOREVIEW,
                "run_with_heartbeat",
                side_effect=fake_execute,
            ):
                output = AUTOREVIEW.run_amp(args, repo, secret_prompt)

        self.assertEqual(json.loads(output), FINAL_REPORT)
        self.assertFalse(observed["mcp_preflight_prompt_exists"])
        self.assertFalse(observed["preflight_prompt_exists"])
        preflight_command = observed["preflight_command"]
        self.assertIsInstance(preflight_command, list)
        assert isinstance(preflight_command, list)
        self.assertEqual(preflight_command[-2:], ["plugins", "list"])
        command = observed["command"]
        self.assertIsInstance(command, list)
        assert isinstance(command, list)
        self.assertIn("--execute", command)
        self.assertIn("--stream-json-input", command)
        self.assertIn("--settings-file", command)
        self.assertNotIn("--orb-execute", command)
        self.assertEqual(command[command.index("--mode") + 1], "autoreview")
        self.assertNotIn(secret_prompt, " ".join(command))
        self.assertNotIn(secret_prompt, str(observed["input"]))
        self.assertEqual(observed["prompt"], secret_prompt)
        self.assertEqual(observed["workspace"], [])
        settings = observed["settings"]
        self.assertIsInstance(settings, dict)
        assert isinstance(settings, dict)
        self.assertNotIn("amp.tools.disable", settings)
        self.assertNotIn("amp.tools.enable", settings)
        self.assertEqual(settings["amp.updates.mode"], "disabled")
        self.assertEqual(
            settings["amp.mcpPermissions"],
            [
                {"matches": {"command": "*"}, "action": "reject"},
                {"matches": {"url": "*"}, "action": "reject"},
            ],
        )
        plugin = observed["plugin"]
        self.assertIsInstance(plugin, str)
        assert isinstance(plugin, str)
        self.assertIn("amp.ai.generate", plugin)
        self.assertIn("amp.registerTool", plugin)
        self.assertIn("amp.createAgent", plugin)
        schema, _ = json.JSONDecoder().raw_decode(plugin.split("schema: ", 1)[1])
        self.assertEqual(schema, {
            "name": "autoreview_report",
            "description": "A security-focused code-review report for the supplied patch.",
            "fields": AUTOREVIEW.PROVIDER_SCHEMA["properties"],
        })
        self.assertIn('tools: ["autoreview_generate"]', plugin)
        self.assertIn("readFileSync", plugin)
        self.assertNotIn(secret_prompt, plugin)
        env = observed["env"]
        self.assertIsInstance(env, dict)
        assert isinstance(env, dict)
        self.assertEqual(env["AMP_API_KEY"], "test-key")
        self.assertNotIn("AMP_URL", env)
        self.assertNotIn("NODE_OPTIONS", env)
        self.assertNotIn("PYTHONPATH", env)
        self.assertEqual(env["PLUGINS"], "all")
        plugin_path = observed["plugin_path"]
        self.assertIsInstance(plugin_path, Path)
        assert isinstance(plugin_path, Path)
        self.assertRegex(plugin_path.stem, r"^autoreview-[0-9a-f]{32}$")
        cwd = observed["cwd"]
        self.assertIsInstance(cwd, Path)
        assert isinstance(cwd, Path)
        self.assertNotEqual(cwd.resolve(), repo.resolve())
        self.assertEqual(Path(env["HOME"]).parent, cwd.parent)

    def test_amp_stream_attestation_rejects_bad_events(self) -> None:
        cwd = Path("/tmp/amp-review-empty")
        misplaced_events = [
            json.loads(line) for line in amp_test_stream(cwd).splitlines()
        ]
        tool_use = misplaced_events[2]["message"]["content"].pop()
        misplaced_events[4]["message"]["content"].append(tool_use)
        misplaced = "\n".join(json.dumps(event) for event in misplaced_events) + "\n"
        extra_result_events = [
            json.loads(line) for line in amp_test_stream(cwd).splitlines()
        ]
        extra_result_events[3]["message"]["content"].append(
            {"type": "text", "text": "unexpected"}
        )
        extra_result = (
            "\n".join(json.dumps(event) for event in extra_result_events) + "\n"
        )
        cases = {
            "malformed": "not-json\n",
            "tools": amp_test_stream(cwd, tools=["autoreview_generate", "shell_command"]),
            "mcp": amp_test_stream(cwd, mcp_servers=[{"name": "server"}]),
            "trigger": amp_test_stream(cwd, trigger="untrusted diff"),
            "wrong tool": amp_test_stream(cwd, tool_name="shell_command"),
            "tool input": amp_test_stream(cwd, tool_input={"command": "id"}),
            "tool result": amp_test_stream(cwd, tool_result_id="wrong-id"),
            "unsanitized error": amp_test_stream(
                cwd,
                tool_error=True,
                tool_result_content="provider echoed PRIVATE_REVIEW_MARKER_8f3c",
            ),
            "multiple init": amp_test_stream(cwd).splitlines()[0] + "\n" + amp_test_stream(cwd),
            "multiple result": amp_test_stream(cwd) + amp_test_stream(cwd).splitlines()[-1] + "\n",
            "misplaced tool use": misplaced,
            "extra tool result content": extra_result,
        }
        for label, stream in cases.items():
            with self.subTest(label=label), self.assertRaisesRegex(
                SystemExit,
                "amp isolation attestation failed",
            ):
                AUTOREVIEW.attest_amp_stream(stream, cwd)

        self.assertTrue(AUTOREVIEW.attest_amp_stream(amp_test_stream(cwd), cwd))
        self.assertFalse(
            AUTOREVIEW.attest_amp_stream(amp_test_stream(cwd, tool_error=True), cwd)
        )

    def test_amp_stream_attestation_preserves_unicode_json_strings(self) -> None:
        cwd = Path("/tmp/amp-review-empty")
        for separator in ("\u0085", "\u2028", "\u2029"):
            final_text = f"Completed.{separator}Synthetic response."
            escaped = amp_test_stream(cwd, final_text=final_text)
            literal = amp_test_stream(cwd, final_text=final_text, ensure_ascii=False)
            self.assertNotIn(separator, escaped)
            self.assertIn(separator, literal)
            escaped_events = [json.loads(line) for line in escaped.split("\n") if line]
            literal_events = [json.loads(line) for line in literal.split("\n") if line]
            self.assertEqual(len(escaped_events), 6)
            self.assertEqual(escaped_events, literal_events)
            for encoding, stream in (("escaped", escaped), ("literal", literal)):
                with self.subTest(separator=f"U+{ord(separator):04X}", encoding=encoding):
                    self.assertTrue(AUTOREVIEW.attest_amp_stream(stream, cwd))

    def test_amp_stream_attestation_keeps_line_framing_and_noise_guards(self) -> None:
        cwd = Path("/tmp/amp-review-empty")
        records = amp_test_stream(cwd).split("\n")[:-1]
        for line_ending in ("\n", "\r\n"):
            for blank_line in ("", " \t"):
                framed = (line_ending + blank_line + line_ending).join(records)
                framed = blank_line + line_ending + framed + line_ending + blank_line
                with self.subTest(line_ending=repr(line_ending), blank_line=blank_line):
                    self.assertTrue(AUTOREVIEW.attest_amp_stream(framed, cwd))
                noisy = line_ending.join([blank_line, *records[:2], "not-json", *records[2:]])
                with self.subTest(line_ending=repr(line_ending), noise=True), self.assertRaisesRegex(
                    SystemExit, "amp isolation attestation failed: malformed stream JSON",
                ):
                    AUTOREVIEW.attest_amp_stream(noisy, cwd)

    @unittest.skipIf(os.name == "nt", "Amp runtime is unsupported on native Windows")
    def test_amp_review_result_preserves_unicode_stream_and_private_report(self) -> None:
        with tempfile.TemporaryDirectory(prefix="autoreview-amp-unicode-test.") as tmpdir:
            root = Path(tmpdir)
            result_path = root / "result.json"
            for separator in ("\u0085", "\u2028", "\u2029"):
                explanation = f"Completed.{separator}Synthetic response."
                report = {
                    **FINAL_REPORT,
                    "overall_explanation": explanation,
                    "review_completion": "complete",
                }
                raw_report = json.dumps(report, ensure_ascii=False)
                result_path.write_text(raw_report, encoding="utf-8")
                result_path.chmod(0o600)
                for ensure_ascii in (True, False):
                    stream = amp_test_stream(
                        root, final_text=explanation, ensure_ascii=ensure_ascii,
                    )
                    process = subprocess.CompletedProcess([], 0, stream, "")
                    with self.subTest(separator=f"U+{ord(separator):04X}", ensure_ascii=ensure_ascii):
                        output = AUTOREVIEW.amp_review_result(
                            process, root, root / "error", result_path,
                        )
                        self.assertEqual(output, raw_report)
                        self.assertEqual(json.loads(output), report)

    @unittest.skipIf(os.name == "nt", "Amp runtime is unsupported on native Windows")
    def test_amp_run_reports_timeout_before_stream_attestation(self) -> None:
        args = argparse.Namespace(
            amp_bin="amp",
            engine_timeout_seconds=0.01,
            max_output_chars=2_000_000,
            model="openai/gpt-5.6-sol",
            stream_engine_output=False,
            thinking="high",
        )

        def fake_preflight(
            command: list[str],
            cwd: Path,
            **kwargs: object,
        ) -> subprocess.CompletedProcess[str]:
            env = kwargs["env"]
            assert isinstance(env, dict)
            if command[-2:] == ["tools", "list"]:
                return amp_test_mcp_denial_result(command, env)
            plugin_root = Path(str(env["XDG_CONFIG_HOME"])) / "amp" / "plugins"
            plugin_path = next(plugin_root.glob("autoreview-*.ts"))
            return subprocess.CompletedProcess(
                command,
                0,
                amp_test_plugin_list(plugin_path),
                "",
            )

        def fake_execute(
            command: list[str],
            cwd: Path,
            **kwargs: object,
        ) -> subprocess.CompletedProcess[str]:
            self.assertEqual(kwargs["max_runtime_seconds"], 0.01)
            return subprocess.CompletedProcess(
                command,
                124,
                '{"type":"system","subtype":"init"}\n',
                "amp engine timed out after 0.01s",
            )

        with tempfile.TemporaryDirectory(prefix="autoreview-amp-timeout-test.") as tmpdir:
            repo = Path(tmpdir) / "repo"
            repo.mkdir()
            with mock.patch.object(
                AUTOREVIEW,
                "ensure_amp_isolation_supported",
                return_value="/usr/bin/amp",
            ), mock.patch.object(
                AUTOREVIEW,
                "run",
                side_effect=fake_preflight,
            ), mock.patch.object(
                AUTOREVIEW,
                "run_with_heartbeat",
                side_effect=fake_execute,
            ), mock.patch.object(
                AUTOREVIEW,
                "attest_amp_stream",
                side_effect=AssertionError("timeout stream must not be attested"),
            ) as attest:
                with self.assertRaises(SystemExit) as exc_info:
                    AUTOREVIEW.run_amp(args, repo, "review")

        message = str(exc_info.exception)
        self.assertIn("amp engine failed (124)", message)
        self.assertIn("amp engine timed out after 0.01s", message)
        attest.assert_not_called()

    def test_amp_failed_process_and_invalid_artifact_keep_runtime_guards(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            cases = (
                (subprocess.CompletedProcess([], 7, "", "provider failed"), "expected exactly one leading"),
                (subprocess.CompletedProcess([], 7, '{"type":"system","subtype":"init"}\n', ""), "unexpected adapter event sequence"),
                (subprocess.CompletedProcess([], 0, amp_test_stream(root, tools=["shell_command"]), ""), "exposed tools"),
                (subprocess.CompletedProcess([], 0, amp_test_stream(root), ""), "produced no result file"),
                (subprocess.CompletedProcess([], 0, '{"type":[]}\n', ""), "unexpected stream event type"),
            )
            for result, diagnostic in cases:
                with self.subTest(diagnostic=diagnostic), self.assertRaises(AUTOREVIEW.ReviewerUnavailable) as caught:
                    AUTOREVIEW.amp_review_result(result, root, root / "error", root / "result")
                self.assertEqual(caught.exception.reason, "runtime_validation_failed")
                self.assertIn(diagnostic, str(caught.exception))
                self.assertEqual(caught.exception.returncode, result.returncode)
            for raw in ("[" * 2000 + "]" * 2000, '{"number":' + "9" * 10000 + "}"):
                with self.subTest(length=len(raw)), self.assertRaises(AUTOREVIEW.ReviewerUnavailable) as caught:
                    AUTOREVIEW.amp_review_result(subprocess.CompletedProcess([], 0, raw, ""), root, root / "error", root / "result")
                self.assertEqual(caught.exception.reason, "runtime_validation_failed")

    def test_amp_plugin_inventory_attestation_fails_closed(self) -> None:
        cwd = Path("/tmp/amp-review-empty")
        plugin_path = cwd.parent / "config" / "amp" / "plugins" / "autoreview-token.ts"
        valid = amp_test_plugin_list(plugin_path)
        AUTOREVIEW.attest_amp_plugin_inventory(valid, plugin_path, cwd)

        cases = {
            "missing": "",
            "inactive": valid.replace("✓", "✗", 1).replace(" active", " error", 1),
            "other plugin": valid
            + amp_test_plugin_list(plugin_path.with_name("unexpected.ts")),
            "event handler": valid + "  events: agent.start\n",
            "other tool": valid.replace(
                "  agent: autoreview-adapter",
                "  tool: shell_command\n  agent: autoreview-adapter",
            ),
        }
        for label, output in cases.items():
            with self.subTest(label=label), self.assertRaisesRegex(
                SystemExit,
                "amp plugin isolation preflight failed",
            ):
                AUTOREVIEW.attest_amp_plugin_inventory(output, plugin_path, cwd)

    @unittest.skipIf(os.name == "nt", "Amp runtime is unsupported on native Windows")
    def test_amp_run_surfaces_direct_generation_failure(self) -> None:
        args = argparse.Namespace(
            amp_bin="amp",
            max_output_chars=2_000_000,
            model="openai/gpt-5.6-sol",
            stream_engine_output=False,
            thinking="high",
        )

        def fake_preflight(
            command: list[str],
            cwd: Path,
            **kwargs: object,
        ) -> subprocess.CompletedProcess[str]:
            env = kwargs["env"]
            assert isinstance(env, dict)
            if command[-2:] == ["tools", "list"]:
                return amp_test_mcp_denial_result(command, env)
            plugin_root = Path(str(env["XDG_CONFIG_HOME"])) / "amp" / "plugins"
            plugin_path = next(plugin_root.glob("autoreview-*.ts"))
            return subprocess.CompletedProcess(
                command,
                0,
                amp_test_plugin_list(plugin_path),
                "",
            )

        def fake_execute(
            command: list[str],
            cwd: Path,
            **kwargs: object,
        ) -> subprocess.CompletedProcess[str]:
            env = kwargs["env"]
            assert isinstance(env, dict)
            error_path = Path(str(env["XDG_CONFIG_HOME"])).parent / "review-error.txt"
            error_path.write_text("provider rejected model", encoding="utf-8")
            error_path.chmod(0o600)
            return subprocess.CompletedProcess(
                command,
                0,
                amp_test_stream(cwd, tool_error=True),
                "",
            )

        with tempfile.TemporaryDirectory(prefix="autoreview-amp-error-test.") as tmpdir:
            repo = Path(tmpdir) / "repo"
            repo.mkdir()
            with mock.patch.object(
                AUTOREVIEW,
                "ensure_amp_isolation_supported",
                return_value="/usr/bin/amp",
            ), mock.patch.object(
                AUTOREVIEW,
                "run",
                side_effect=fake_preflight,
            ), mock.patch.object(
                AUTOREVIEW,
                "run_with_heartbeat",
                side_effect=fake_execute,
            ):
                with self.assertRaisesRegex(SystemExit, "provider rejected model"):
                    AUTOREVIEW.run_amp(args, repo, "review")


class AutoreviewInputTests(unittest.TestCase):


    def test_every_provider_reviews_each_pack_without_a_scanner(self) -> None:
        for engine in ("codex", "claude", "amp", "pi"):
            with self.subTest(engine=engine), tempfile.TemporaryDirectory() as tempdir:
                args = argparse.Namespace(engine=engine, max_priority="P0")
                prompts = [f"complete pack {index}: unicode π\r\n-context\n+change\n" for index in range(2)]
                with mock.patch.object(AUTOREVIEW, "find_command", side_effect=AssertionError("unexpected scanner lookup")), \
                        mock.patch.object(AUTOREVIEW, "run", side_effect=AssertionError("unexpected scanner process")), \
                        mock.patch.object(
                            AUTOREVIEW, f"run_{engine}",
                            return_value=json.dumps({**FINAL_REPORT, "review_completion": "complete"}),
                        ) as provider:
                    for prompt in prompts:
                        result = AUTOREVIEW.run_reviewer(args, Path(tempdir), prompt, set(), [])
                        self.assertTrue(result.complete)
                        self.assertEqual(result.report["findings"], [])
                self.assertEqual([call.args[2] for call in provider.call_args_list], prompts)

    def test_binary_stdin_preserves_utf8_and_crlf_bytes(self) -> None:
        payload = "unicode \u03c0\r\nnext\n".encode("utf-8")
        with tempfile.TemporaryDirectory() as tempdir, tempfile.TemporaryFile() as source:
            source.write(payload)
            source.seek(0)
            result = AUTOREVIEW.run(
                [sys.executable, "-c", "import sys; print(sys.stdin.buffer.read().hex())"],
                Path(tempdir), stdin=source,
            )
        self.assertEqual(result.stdout.strip(), payload.hex())


class AutoreviewEfficiencyTests(unittest.TestCase):
    @staticmethod
    def usage_event(multiplier=1):
        return json.dumps({"type": "turn.completed", "usage": {
            "input_tokens": 100 * multiplier, "cached_input_tokens": 20 * multiplier,
            "output_tokens": 30 * multiplier, "reasoning_output_tokens": 10 * multiplier,
        }})

    def test_usage_keeps_last_cumulative_snapshot_and_sums_fresh_attempts(self):
        args = argparse.Namespace()
        AUTOREVIEW.record_codex_usage(args, self.usage_event() + "\n" + self.usage_event(2))
        AUTOREVIEW.record_codex_usage(args, self.usage_event(3))
        self.assertEqual(AUTOREVIEW.review_usage_summary(args), {
            "attempts": 2, "reported_attempts": 2, "unknown_attempts": 0,
            "partial_attempts": 0, "complete": True,
            "tokens": {"input_tokens": 500, "cached_input_tokens": 100,
                       "output_tokens": 150, "reasoning_output_tokens": 50},
        })

    def test_usage_missing_or_invalid_terminal_snapshot_is_unknown(self):
        for invalid in ("", "malformed", '{"type":"turn.failed","error":{}}',
                        '{"type":"turn.completed","usage":{}}',
                        self.usage_event().replace('100', 'true'),
                        self.usage_event().replace('100', '-1')):
            with self.subTest(invalid=invalid):
                args = argparse.Namespace()
                AUTOREVIEW.record_codex_usage(args, invalid)
                self.assertEqual(AUTOREVIEW.review_usage_summary(args), {
                    "attempts": 1, "reported_attempts": 0, "unknown_attempts": 1,
                    "partial_attempts": 0, "complete": False, "tokens": None,
                })
                AUTOREVIEW.record_codex_usage(args, self.usage_event())
                summary = AUTOREVIEW.review_usage_summary(args)
                self.assertEqual(summary["unknown_attempts"], 1)
                self.assertFalse(summary["complete"])
                self.assertEqual(summary["tokens"]["input_tokens"], 100)
        args = argparse.Namespace()
        AUTOREVIEW.record_codex_usage(args, self.usage_event() + '\n{"type":"turn.completed"}')
        summary = AUTOREVIEW.review_usage_summary(args)
        self.assertFalse(summary["complete"])
        self.assertEqual(summary["partial_attempts"], 1)
        self.assertEqual(summary["tokens"]["input_tokens"], 100)

    def test_failed_or_timed_out_attempt_keeps_observed_lower_bound(self):
        for suffix in ('\n{"type":"turn.failed"}', '\n{"type":"turn.started"}', ""):
            with self.subTest(suffix=suffix):
                args = argparse.Namespace()
                AUTOREVIEW.record_codex_usage(args, self.usage_event() + suffix, completed=False)
                summary = AUTOREVIEW.review_usage_summary(args)
                self.assertFalse(summary["complete"])
                self.assertEqual(summary["partial_attempts"], 1)
                self.assertEqual(summary["tokens"]["input_tokens"], 100)

    def test_codex_zero_default_without_usage_sample_is_unknown(self):
        for earlier in ("", self.usage_event() + "\n"):
            with self.subTest(earlier=bool(earlier)):
                args = argparse.Namespace()
                AUTOREVIEW.record_codex_usage(args, earlier + self.usage_event(0))
                summary = AUTOREVIEW.review_usage_summary(args)
                self.assertFalse(summary["complete"])
                self.assertEqual(summary["unknown_attempts"], 0 if earlier else 1)
                self.assertEqual(summary["partial_attempts"], 1 if earlier else 0)
                self.assertEqual(summary["tokens"]["input_tokens"] if earlier else summary["tokens"],
                                 100 if earlier else None)

    def test_malformed_usage_cannot_break_report_acceptance(self):
        for event in ('{"type":[]}', '[' * 2000 + ']' * 2000,
                      '{"n":' + '9' * 10000 + '}', 'not json'):
            with self.subTest(event=event[:20]):
                args = argparse.Namespace()
                AUTOREVIEW.record_codex_usage(args, event)
                self.assertIsNone(AUTOREVIEW.review_usage_summary(args)["tokens"])
        args = argparse.Namespace()
        event = json.loads(self.usage_event())
        event["usage"]["cache_write_input_tokens"] = 80
        AUTOREVIEW.record_codex_usage(args, json.dumps(event))
        self.assertTrue(AUTOREVIEW.review_usage_summary(args)["complete"])

    def test_interruption_retains_observed_usage_with_and_without_live_display(self):
        for streaming in (False, True):
            with self.subTest(streaming=streaming), tempfile.TemporaryDirectory() as tempdir:
                def interrupt(*_args):
                    raise AUTOREVIEW.EngineInterrupted(130)

                script = f"import time; print({self.usage_event()!r}, flush=True); time.sleep(5)"
                with mock.patch.object(AUTOREVIEW, "emit_heartbeat", side_effect=interrupt), \
                        self.assertRaises(AUTOREVIEW.EngineInterrupted) as caught:
                    AUTOREVIEW.run_with_heartbeat(
                        [sys.executable, "-c", script], Path(tempdir), label="usage-fixture",
                        heartbeat_seconds=0.2, stream_output=streaming, stream_display=interrupt,
                    )
                args = argparse.Namespace()
                AUTOREVIEW.record_codex_usage(args, caught.exception.stdout, completed=False)
                summary = AUTOREVIEW.review_usage_summary(args)
                self.assertEqual(summary["tokens"]["input_tokens"], 100)
                self.assertEqual(summary["partial_attempts"], 1)
                self.assertFalse(summary["complete"])

    def test_planner_reduces_repeated_context_without_more_passes(self):
        bundle = "# Commit Diff\n" + "+change\n" * 75_000
        datasets = [AUTOREVIEW.ReviewDataset("evidence.txt", "evidence π\r\n" * (800_000 // 13))]
        with mock.patch.object(AUTOREVIEW, "current_branch", return_value="topic"):
            with mock.patch.object(AUTOREVIEW, "optimize_evidence_plan", side_effect=lambda plan, *args: plan):
                legacy = AUTOREVIEW.build_review_prompts(Path("."), "commit", "HEAD", bundle, "", datasets)
            planned = AUTOREVIEW.build_review_prompts(Path("."), "commit", "HEAD", bundle, "", datasets)
        self.assertLessEqual(len(planned), len(legacy))
        self.assertLess(AUTOREVIEW.review_plan_bytes(planned), AUTOREVIEW.review_plan_bytes(legacy))
        # Full cross-product and byte-offset reconstruction are exercised by the
        # hardening suite; this fixture measures the formerly repeated context.
        self.assertTrue(all(AUTOREVIEW.utf8_size(prompt) <= AUTOREVIEW.MAX_REVIEW_PROMPT_BYTES
                            for prompt in planned))

    def test_planner_retains_legacy_when_bytes_or_passes_would_regress(self):
        baseline = ["a" * 100, "b" * 100]
        for candidate in (["x", "y", "z"], ["x" * 201], ["x" * 300, "y"]):
            with self.subTest(candidate=candidate):
                planned = AUTOREVIEW.optimize_evidence_plan(
                    baseline, 200, 100, [AUTOREVIEW.ReviewDataset("evidence", "z" * 100)],
                    lambda _limit, _max_passes: candidate,
                )
                self.assertEqual(planned, baseline)

    def test_explicit_pass_budget_requires_a_positive_integer(self):
        for value in ("0", "-1", "1.5"):
            with self.subTest(value=value), mock.patch.dict(os.environ, {}, clear=True), \
                    mock.patch.object(sys, "argv", ["autoreview", "--max-review-passes", value]), \
                    contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit):
                    AUTOREVIEW.parse_args()


class AutoreviewKimiRefusalTests(unittest.TestCase):
    @contextlib.contextmanager
    def no_engine_activity(self):
        names = (
            "find_command", "resolve_command", "run", "run_with_heartbeat", "run_with_stream",
            "safe_temp_root", "run_codex", "run_claude", "run_amp", "run_pi",
        )
        guards = {name: mock.Mock(side_effect=AssertionError(f"refused engine reached {name}"))
                  for name in names}
        with contextlib.ExitStack() as stack:
            for name, guard in guards.items():
                stack.enter_context(mock.patch.object(AUTOREVIEW, name, guard))
            for name in ("open", "read_text", "read_bytes"):
                guard = mock.Mock(side_effect=AssertionError("refused engine read configuration/auth"))
                guards[f"Path.{name}"] = guard
                stack.enter_context(mock.patch.object(Path, name, guard))
            guard = mock.Mock(side_effect=AssertionError("refused engine staged a runtime"))
            guards["TemporaryDirectory"] = guard
            stack.enter_context(mock.patch.object(AUTOREVIEW.tempfile, "TemporaryDirectory", guard))
            yield guards

    def assert_private_input_diagnostic(self, message):
        self.assertIn("kimi review is unavailable", str(message).lower())
        self.assertIn("private input channel", str(message).lower())

    def test_kimi_explicit_and_environment_selection_refuse_private_input(self):
        for environment in (False, True):
            for dry_run in (False, True):
                with self.subTest(environment=environment, dry_run=dry_run):
                    env = {"AUTOREVIEW_ENGINE": "kimi"} if environment else {}
                    argv = ["autoreview", "--kimi-bin", "synthetic-kimi"]
                    if not environment:
                        argv += ["--engine", "kimi"]
                    if dry_run:
                        argv += ["--dry-run"]
                    with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(sys, "argv", argv):
                        args = AUTOREVIEW.parse_args()
                        self.assertEqual((args.engine, args.kimi_bin), ("kimi", "synthetic-kimi"))
                        with self.no_engine_activity() as guards:
                            with self.assertRaises(SystemExit) as caught:
                                AUTOREVIEW.reviewer_args(args)
                    self.assert_private_input_diagnostic(caught.exception.code)
                    for guard in guards.values():
                        guard.assert_not_called()

    def test_kimi_direct_dispatch_refuses_before_engine_activity(self):
        args = argparse.Namespace(engine="kimi", kimi_bin="synthetic-kimi", model=None,
                                  thinking=None, stream_engine_output=False)
        with self.no_engine_activity() as guards:
            with self.assertRaises(SystemExit) as caught:
                AUTOREVIEW.run_engine(args, Path.cwd(), "synthetic private review text")
        self.assert_private_input_diagnostic(caught.exception.code)
        for guard in guards.values():
            guard.assert_not_called()

    def test_kimi_preflight_refuses_before_engine_activity(self):
        args = argparse.Namespace(engine="kimi", kimi_bin="synthetic-kimi")
        with self.no_engine_activity() as guards:
            available, reason = AUTOREVIEW.resolve_engine_binary(args, Path.cwd())
        self.assertFalse(available)
        self.assert_private_input_diagnostic(reason)
        for guard in guards.values():
            guard.assert_not_called()


class AutoreviewCompatibilityTests(unittest.TestCase):
    def test_default_reviewer_uses_sol_61_high_with_sol_6_access_retry(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(sys, "argv", ["autoreview"]):
            reviewer = AUTOREVIEW.reviewer_args(AUTOREVIEW.parse_args())[0]
        self.assertEqual(reviewer.engine, "codex")
        self.assertEqual(reviewer.model, "gpt-6.1-sol")
        self.assertEqual(reviewer.thinking, "high")
        self.assertEqual(reviewer.fallback_model, "gpt-6-sol")

    def test_sol_61_and_astra_reject_unsupported_effort_before_preparation(self) -> None:
        with tempfile.TemporaryDirectory(prefix="autoreview-invalid-effort.") as tempdir:
            for model, effort, source in itertools.product(
                (None, "gpt-6.1-sol", "gpt-6-astra"),
                ("none", "minimal", "ultra"),
                ("cli", "keyed-cli", "environment", "global-environment"),
            ):
                with self.subTest(model=model, effort=effort, source=source):
                    argv = [sys.executable, str(SCRIPT_PATH), "--engine", "codex",
                            "--codex-bin", str(Path(tempdir) / "missing-codex")]
                    env = {key: value for key, value in os.environ.items()
                           if not key.startswith("AUTOREVIEW_")}
                    if source in {"cli", "keyed-cli"}:
                        prefix = "codex=" if source == "keyed-cli" else ""
                        argv += ["--thinking", prefix + effort]
                        if model:
                            argv += ["--model", prefix + model]
                    else:
                        prefix = "AUTOREVIEW_CODEX_" if source == "environment" else "AUTOREVIEW_"
                        env[prefix + "THINKING"] = effort
                        if model:
                            env[prefix + "MODEL"] = model
                    # No Git repository or engine exists: rejection must precede preparation.
                    result = subprocess.run(argv, cwd=tempdir, env=env, text=True,
                                            capture_output=True, timeout=30)
                    self.assertEqual(result.returncode, 1, result.stderr)
                    self.assertEqual(result.stdout, "")
                    self.assertEqual(result.stderr.strip(),
                                     f"invalid thinking level for codex model {model or 'gpt-6.1-sol'}: {effort} "
                                     "(valid: high, low, max, medium, xhigh)")

    def test_model_validation_uses_effective_cli_overrides(self) -> None:
        cases = (
            ({}, ["--thinking", "minimal", "--thinking", "codex=high"], "gpt-6.1-sol", "high"),
            ({"AUTOREVIEW_THINKING": "none", "AUTOREVIEW_CODEX_THINKING": "high"},
             [], "gpt-6.1-sol", "high"),
            ({"AUTOREVIEW_CODEX_THINKING": "minimal"},
             ["--thinking", "high"], "gpt-6.1-sol", "high"),
            ({"AUTOREVIEW_CODEX_MODEL": "gpt-6.1-sol", "AUTOREVIEW_CODEX_THINKING": "none"},
             ["--thinking", "high"], "gpt-6.1-sol", "high"),
            ({"AUTOREVIEW_CODEX_MODEL": "gpt-6.1-sol", "AUTOREVIEW_CODEX_THINKING": "none"},
             ["--model", "gpt-6-sol"], "gpt-6-sol", "none"),
            ({"AUTOREVIEW_CODEX_MODEL": "gpt-6-astra", "AUTOREVIEW_CODEX_THINKING": "none"},
             ["--thinking", "high"], "gpt-6-astra", "high"),
            ({"AUTOREVIEW_CODEX_MODEL": "gpt-6-astra", "AUTOREVIEW_CODEX_THINKING": "minimal"},
             ["--model", "gpt-5.6-sol"], "gpt-5.6-sol", "minimal"),
        )
        for env, overrides, model, effort in cases:
            with self.subTest(overrides=overrides), mock.patch.dict(os.environ, env, clear=True), \
                    mock.patch.object(sys, "argv", ["autoreview", "--engine", "codex", *overrides]):
                reviewer = AUTOREVIEW.reviewer_args(AUTOREVIEW.parse_args())[0]
                self.assertEqual(reviewer.model, model)
                self.assertEqual(reviewer.thinking, effort)

    def test_effort_only_cli_and_environment_preserve_supported_models(self) -> None:
        for effort in ("none", "minimal", "low", "medium", "high", "xhigh", "max"):
            selections = (
                (["--thinking", effort], {}),
                (["--thinking", "codex=" + effort], {}),
                ([], {"AUTOREVIEW_THINKING": effort}),
                ([], {"AUTOREVIEW_CODEX_THINKING": effort}),
            )
            for thinking_args, env in selections:
                with self.subTest(effort=effort, thinking_args=thinking_args, env=env):
                    with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(
                        sys, "argv", ["autoreview", *thinking_args],
                    ):
                        if effort in {"none", "minimal"}:
                            with self.assertRaisesRegex(SystemExit, "invalid thinking level for codex model gpt-6.1-sol"):
                                AUTOREVIEW.reviewer_args(AUTOREVIEW.parse_args())
                            continue
                        reviewer = AUTOREVIEW.reviewer_args(AUTOREVIEW.parse_args())[0]
                    self.assertEqual(reviewer.model, "gpt-6.1-sol")
                    self.assertEqual(reviewer.thinking, effort)
                    self.assertEqual(reviewer.fallback_model, "gpt-6-sol")

    def test_sol_and_luna_validate_effort_and_explicit_model_selections(self) -> None:
        for model, fallback in (("gpt-6.1-sol", "gpt-6-sol"), ("gpt-6-sol", "gpt-6-luna"), ("gpt-6-luna", None)):
            selections = (
                (["--model", model], {}),
                (["--model", "codex=" + model], {}),
                ([], {"AUTOREVIEW_MODEL": model}),
                ([], {"AUTOREVIEW_CODEX_MODEL": model}),
            )
            for model_args, env in selections:
                for effort in (None, "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"):
                    with self.subTest(model=model, model_args=model_args, env=env, effort=effort):
                        argv = ["autoreview", *model_args]
                        if effort:
                            argv += ["--thinking", effort]
                        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(sys, "argv", argv):
                            if effort in {"minimal", "ultra"} or (model == "gpt-6.1-sol" and effort == "none"):
                                with self.assertRaisesRegex(SystemExit, f"invalid thinking level for codex model {model}"):
                                    AUTOREVIEW.reviewer_args(AUTOREVIEW.parse_args())
                                continue
                            reviewer = AUTOREVIEW.reviewer_args(AUTOREVIEW.parse_args())[0]
                        self.assertEqual(reviewer.model, model)
                        self.assertEqual(reviewer.thinking, effort or "high")
                        self.assertEqual(reviewer.fallback_model, fallback)

    def test_astra_preserves_supported_effort_and_explicit_model(self) -> None:
        selections = (
            (["--model", "gpt-6-astra"], {}),
            (["--model", "codex=gpt-6-astra"], {}),
            ([], {"AUTOREVIEW_MODEL": "gpt-6-astra"}),
            ([], {"AUTOREVIEW_CODEX_MODEL": "gpt-6-astra"}),
        )
        for model_args, env in selections:
            for effort in (None, "low", "medium", "high", "xhigh", "max"):
                with self.subTest(model_args=model_args, env=env, effort=effort):
                    argv = ["autoreview", "--engine", "codex", *model_args]
                    if effort:
                        argv += ["--thinking", effort]
                    with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(sys, "argv", argv):
                        reviewer = AUTOREVIEW.reviewer_args(AUTOREVIEW.parse_args())[0]
                    self.assertEqual(reviewer.model, "gpt-6-astra")
                    self.assertEqual(reviewer.thinking, effort or "high")
                    self.assertIsNone(reviewer.fallback_model)

    def test_astra_effort_restrictions_do_not_change_other_codex_models(self) -> None:
        for effort in ("none", "minimal"):
            with self.subTest(effort=effort), mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(
                sys, "argv", ["autoreview", "--engine", "codex", "--model", "gpt-5.6-sol", "--thinking", effort],
            ):
                reviewer = AUTOREVIEW.reviewer_args(AUTOREVIEW.parse_args())[0]
                self.assertEqual(reviewer.model, "gpt-5.6-sol")
                self.assertEqual(reviewer.thinking, effort)
                self.assertEqual(reviewer.fallback_model, "gpt-5.6-terra")

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

    def test_kimi_bin_cli_option(self) -> None:
        with mock.patch.object(
            sys,
            "argv",
            ["autoreview", "--kimi-bin", "/tmp/trusted-kimi"],
        ):
            args = AUTOREVIEW.parse_args()
        self.assertEqual(args.kimi_bin, "/tmp/trusted-kimi")

    def test_codex_config_status_exposes_keys_only(self) -> None:
        args = argparse.Namespace(codex_config=['model_verbosity="low"'])
        self.assertEqual(AUTOREVIEW.codex_config_keys(args), ["model_verbosity"])

    def test_codex_retries_sol_6_after_default_sol_61_access_failure(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(
            sys, "argv", ["autoreview", "--no-web-search"],
        ):
            args = AUTOREVIEW.reviewer_args(AUTOREVIEW.parse_args())[0]
        prompt = "complete retry pack: unicode \u03c0\r\n-deleted line\n unchanged context\n"
        with tempfile.TemporaryDirectory(prefix="autoreview-codex-fallback.") as tmpdir:
            events = []

            def fake_run(command, _cwd, **kwargs):
                self.assertEqual(kwargs["input_text"], prompt)
                model = command[command.index("--model") + 1]
                events.append(model)
                self.assertIn('model_reasoning_effort="high"', command)
                if model == "gpt-6.1-sol":
                    return subprocess.CompletedProcess(
                        command, 1, AutoreviewEfficiencyTests.usage_event(),
                        "The model `gpt-6.1-sol` does not exist or you do not have access to it.",
                    )
                output_path = Path(command[command.index("--output-last-message") + 1])
                output_path.write_text(json.dumps({**FINAL_REPORT, "review_completion": "complete"}))
                return subprocess.CompletedProcess(command, 0, AutoreviewEfficiencyTests.usage_event(2), "")

            with mock.patch.object(AUTOREVIEW, "resolve_command", return_value="/usr/bin/codex"), \
                    mock.patch.object(AUTOREVIEW, "ensure_codex_isolation_supported", return_value="/usr/bin/codex"), \
                    mock.patch.object(AUTOREVIEW, "codex_auth_config_flags", return_value=[]), \
                    mock.patch.object(AUTOREVIEW, "prepare_codex_runtime_auth", return_value=None), \
                    mock.patch.object(AUTOREVIEW, "find_command", side_effect=AssertionError("unexpected scanner lookup")), \
                    mock.patch.object(AUTOREVIEW, "run_with_heartbeat", side_effect=fake_run):
                result = AUTOREVIEW.run_reviewer(args, Path(tmpdir), prompt, set(), [])
                self.assertTrue(result.complete)
                self.assertEqual(result.report["findings"], [])
            self.assertEqual(events, ["gpt-6.1-sol", "gpt-6-sol"])
            usage = AUTOREVIEW.review_usage_summary(args)
            self.assertEqual(usage["attempts"], 2)
            self.assertEqual(usage["tokens"]["input_tokens"], 300)
            self.assertEqual(usage["partial_attempts"], 1)
            self.assertFalse(usage["complete"])

    def test_default_sol_61_retries_only_access_failure_without_chaining(self) -> None:
        failures = (
            ("network timeout", False),
            ("rate limit exceeded for {model}", False),
            ("model_not_available: {model} is temporarily unavailable due to capacity", False),
            ("Unsupported value: 'none' is not supported with the '{model}' model", False),
            ("The '{model}' model is not supported when using Codex with a ChatGPT account.", True),
        )
        for message, retries in failures:
            with self.subTest(message=message), mock.patch.dict(os.environ, {}, clear=True), mock.patch.object(
                sys, "argv", ["autoreview", "--no-web-search"],
            ):
                args = AUTOREVIEW.reviewer_args(AUTOREVIEW.parse_args())[0]
                models = []

                def fake_run(command, *_args, **_kwargs):
                    model = command[command.index("--model") + 1]
                    models.append(model)
                    event = {"type": "error", "message": message.format(model=model)}
                    return subprocess.CompletedProcess(command, 1, json.dumps(event), "")

                with tempfile.TemporaryDirectory(prefix="autoreview-codex-fallback.") as tmpdir, \
                        mock.patch.object(AUTOREVIEW, "resolve_command", return_value="/usr/bin/codex"), \
                        mock.patch.object(AUTOREVIEW, "ensure_codex_isolation_supported", return_value="/usr/bin/codex"), \
                        mock.patch.object(AUTOREVIEW, "codex_auth_config_flags", return_value=[]), \
                        mock.patch.object(AUTOREVIEW, "prepare_codex_runtime_auth", return_value=None), \
                        mock.patch.object(AUTOREVIEW, "run_with_heartbeat", side_effect=fake_run):
                    with self.assertRaises(AUTOREVIEW.ReviewerUnavailable):
                        AUTOREVIEW.run_codex(args, Path(tmpdir), "review")
                self.assertEqual(models, ["gpt-6.1-sol", "gpt-6-sol"] if retries else ["gpt-6.1-sol"])

    def test_codex_runs_outside_repo_with_bundle_only_workspace(self) -> None:
        args = argparse.Namespace(
            codex_bin="codex",
            codex_config=None,
            codex_speed=None,
            fallback_model=None,
            model="gpt-5.6-sol",
            stream_engine_output=False,
            thinking="high",
            tools=True,
            web_search=False,
        )
        observed: dict[str, object] = {}

        def fake_run(
            command: list[str],
            cwd: Path,
            *_args: object,
            **kwargs: object,
        ) -> subprocess.CompletedProcess[str]:
            observed["cwd"] = cwd
            observed["command"] = command
            observed["command_cwd"] = Path(command[command.index("-C") + 1])
            observed["workspace_entries"] = list(cwd.iterdir())
            observed["env"] = kwargs["env"]
            observed["schema"] = json.loads(Path(command[command.index("--output-schema") + 1]).read_text())
            output_path = Path(command[command.index("--output-last-message") + 1])
            output_path.write_text(json.dumps(FINAL_REPORT))
            return subprocess.CompletedProcess(command, 0, "", "")

        with tempfile.TemporaryDirectory(prefix="autoreview-codex-workspace-test.") as tmpdir:
            repo = Path(tmpdir)
            (repo / ".env").write_text("ignored environment fixture\n")
            with mock.patch.dict(
                os.environ,
                {"CODEX_HOME": ""},
                clear=False,
            ), mock.patch.object(
                AUTOREVIEW,
                "resolve_command",
                return_value="/usr/bin/codex",
            ), mock.patch.object(
                AUTOREVIEW,
                "ensure_codex_isolation_supported",
                return_value="/usr/bin/codex",
            ), mock.patch.object(
                AUTOREVIEW,
                "codex_auth_config_flags",
                return_value=[],
            ), mock.patch.object(
                AUTOREVIEW,
                "prepare_codex_runtime_auth",
                return_value=None,
            ), mock.patch.object(
                AUTOREVIEW,
                "codex_source_home",
                return_value=None,
            ), mock.patch.object(
                AUTOREVIEW,
                "run_with_heartbeat",
                side_effect=fake_run,
            ):
                output = AUTOREVIEW.run_codex(args, repo, "review")

            self.assertEqual(json.loads(output), FINAL_REPORT)
            self.assertEqual(observed["schema"], AUTOREVIEW.PROVIDER_SCHEMA)
            observed_cwd = observed["cwd"]
            command_cwd = observed["command_cwd"]
            self.assertIsInstance(observed_cwd, Path)
            self.assertIsInstance(command_cwd, Path)
            assert isinstance(observed_cwd, Path)
            assert isinstance(command_cwd, Path)
            self.assertNotEqual(observed_cwd.resolve(), repo.resolve())
            self.assertEqual(observed_cwd, command_cwd)
            self.assertEqual(observed["workspace_entries"], [])
            env = observed["env"]
            self.assertIsInstance(env, dict)
            assert isinstance(env, dict)
            self.assertNotEqual(env["HOME"], os.environ.get("HOME"))
            self.assertEqual(env["USERPROFILE"], env["HOME"])
            self.assertNotEqual(env.get("CODEX_HOME"), str(repo.resolve()))
            self.assertEqual(Path(env["CODEX_HOME"]).name, "codex-home")
            self.assertNotEqual(env["CODEX_HOME"], str((Path.home() / ".codex").resolve()))
            self.assertIn("features.shell_snapshot=false", observed["command"])
            self.assertIn("features.hooks=false", observed["command"])
            self.assertIn("features.plugins=false", observed["command"])
            self.assertIn("skills.include_instructions=false", observed["command"])

    def test_codex_does_not_fallback_after_unrelated_failure(self) -> None:
        args = argparse.Namespace(
            codex_bin="codex",
            codex_config=None,
            codex_speed=None,
            fallback_model="gpt-6-luna",
            model="gpt-6-sol",
            stream_engine_output=False,
            thinking="high",
            tools=True,
            web_search=False,
        )
        models: list[str] = []

        def fake_run(command: list[str], *_args: object, **_kwargs: object) -> subprocess.CompletedProcess[str]:
            models.append(command[command.index("--model") + 1])
            return subprocess.CompletedProcess(command, 1, "", "network timeout")

        with tempfile.TemporaryDirectory(prefix="autoreview-codex-fallback.") as tmpdir, mock.patch.object(
            AUTOREVIEW,
            "resolve_command",
            return_value="/usr/bin/codex",
        ), mock.patch.object(
            AUTOREVIEW,
            "ensure_codex_isolation_supported",
            return_value="/usr/bin/codex",
        ), mock.patch.object(AUTOREVIEW, "codex_auth_config_flags", return_value=[]), mock.patch.object(
            AUTOREVIEW,
            "prepare_codex_runtime_auth",
            return_value=None,
        ), mock.patch.object(
            AUTOREVIEW,
            "run_with_heartbeat",
            side_effect=fake_run,
        ):
            with self.assertRaisesRegex(SystemExit, "network timeout"):
                AUTOREVIEW.run_codex(args, Path(tmpdir), "review")

        self.assertEqual(models, ["gpt-6-sol"])

    def test_codex_does_not_fallback_after_model_capacity_failure(self) -> None:
        args = argparse.Namespace(
            codex_bin="codex",
            codex_config=None,
            codex_speed=None,
            fallback_model="gpt-6-luna",
            model="gpt-6-sol",
            stream_engine_output=False,
            thinking="high",
            tools=True,
            web_search=False,
        )
        models: list[str] = []

        def fake_run(command: list[str], *_args: object, **_kwargs: object) -> subprocess.CompletedProcess[str]:
            models.append(command[command.index("--model") + 1])
            return subprocess.CompletedProcess(
                command,
                1,
                "",
                "model_not_available: gpt-6-sol is temporarily unavailable due to capacity",
            )

        with tempfile.TemporaryDirectory(prefix="autoreview-codex-fallback.") as tmpdir, mock.patch.object(
            AUTOREVIEW,
            "resolve_command",
            return_value="/usr/bin/codex",
        ), mock.patch.object(
            AUTOREVIEW,
            "ensure_codex_isolation_supported",
            return_value="/usr/bin/codex",
        ), mock.patch.object(AUTOREVIEW, "codex_auth_config_flags", return_value=[]), mock.patch.object(
            AUTOREVIEW,
            "prepare_codex_runtime_auth",
            return_value=None,
        ), mock.patch.object(
            AUTOREVIEW,
            "run_with_heartbeat",
            side_effect=fake_run,
        ):
            with self.assertRaisesRegex(SystemExit, "temporarily unavailable"):
                AUTOREVIEW.run_codex(args, Path(tmpdir), "review")

        self.assertEqual(models, ["gpt-6-sol"])

    def test_codex_access_fallback_ignores_structured_output_text(self) -> None:
        result = subprocess.CompletedProcess(
            ["codex"],
            1,
            '{"type":"agent_message","text":"gpt-5.6-sol does not exist or you do not have access"}',
            '{"type":"agent_message","message":"gpt-5.6-sol does not exist or you do not have access"}',
        )

        self.assertFalse(
            AUTOREVIEW.codex_model_access_failure(result, "gpt-5.6-sol")
        )

    def test_codex_access_fallback_accepts_terminal_error_event(self) -> None:
        result = subprocess.CompletedProcess(
            ["codex"],
            1,
            '{"type":"error","message":"gpt-5.6-sol does not exist or you do not have access"}',
            "",
        )

        self.assertTrue(
            AUTOREVIEW.codex_model_access_failure(result, "gpt-5.6-sol")
        )

    def test_codex_access_fallback_accepts_account_model_list_error(self) -> None:
        result = subprocess.CompletedProcess(
            ["codex"],
            1,
            "",
            (
                "The model gpt-5.6-sol does not appear in the list of models "
                "available to your account"
            ),
        )

        self.assertTrue(
            AUTOREVIEW.codex_model_access_failure(result, "gpt-5.6-sol")
        )

    def test_codex_access_fallback_ignores_plain_stdout(self) -> None:
        message = "gpt-5.6-sol does not exist or you do not have access"
        stdout_result = subprocess.CompletedProcess(["codex"], 1, message, "")
        stderr_result = subprocess.CompletedProcess(["codex"], 1, "", message)

        self.assertFalse(
            AUTOREVIEW.codex_model_access_failure(stdout_result, "gpt-5.6-sol")
        )
        self.assertTrue(
            AUTOREVIEW.codex_model_access_failure(stderr_result, "gpt-5.6-sol")
        )

    def test_extract_json_accepts_dict_result_payload(self) -> None:
        payload = {
            "type": "result",
            "subtype": "success",
            "result": FINAL_REPORT,
            "session_id": "session-id",
            "request_id": "request-id",
        }
        self.assertEqual(AUTOREVIEW.extract_json(json.dumps(payload)), FINAL_REPORT)

    def test_extract_json_rejects_result_string_with_preamble(self) -> None:
        payload = {
            "type": "result",
            "subtype": "success",
            "result": "Inspecting the diff first.\n" + json.dumps(FINAL_REPORT),
        }
        with self.assertRaisesRegex(SystemExit, "result was not structured JSON"):
            AUTOREVIEW.extract_json(json.dumps(payload))

if __name__ == "__main__":
    unittest.main()

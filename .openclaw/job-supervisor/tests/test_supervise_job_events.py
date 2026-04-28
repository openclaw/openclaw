import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

import adapt_codex_result
import adapt_gemini_result
import dispatch_raw_result
import supervise_job_events
import write_codex_result


class SuperviseJobEventsTests(unittest.TestCase):
    def test_trim_state_prunes_old_terminal_jobs_and_keeps_recent_or_active_jobs(self):
        state = {
            "schemaVersion": "job-supervisor-state-v1",
            "jobs": {
                "old-terminal": {
                    "source": "codex",
                    "lastObservedAtUtc": "2026-02-01T00:00:00Z",
                    "lastStatus": "succeeded",
                },
                "old-active": {
                    "source": "gemini",
                    "lastObservedAtUtc": "2026-02-01T00:00:00Z",
                    "lastStatus": "running",
                },
                "fresh-terminal": {
                    "source": "codex",
                    "lastObservedAtUtc": "2026-04-02T00:00:00Z",
                    "lastStatus": "failed",
                },
            },
            "seenEventKeys": [f"event-{index}" for index in range(4)],
            "sentNotifications": [f"dedupe-{index}" for index in range(4)],
        }

        supervise_job_events.trim_state(
            state,
            retention_days=30,
            max_jobs=10,
            max_dedupe_entries=2,
            now=datetime(2026, 4, 3, 0, 0, 0, tzinfo=timezone.utc),
        )

        self.assertNotIn("old-terminal", state["jobs"])
        self.assertIn("old-active", state["jobs"])
        self.assertIn("fresh-terminal", state["jobs"])
        self.assertEqual(["event-2", "event-3"], state["seenEventKeys"])
        self.assertEqual(["dedupe-2", "dedupe-3"], state["sentNotifications"])

    def test_process_event_keeps_duplicate_suppression_after_state_trim(self):
        state = supervise_job_events.load_state(Path("/tmp/nonexistent-supervisor-state.json"))
        event = {
            "schemaVersion": "completion-event-v1",
            "source": "codex",
            "jobId": "codex-retention-check",
            "sequence": 7,
            "eventKind": "completion",
            "status": "succeeded",
            "observedAtUtc": "2026-04-03T11:00:00Z",
            "completedAtUtc": "2026-04-03T10:59:00Z",
            "summary": "Retention eklendi.",
            "modifiedFiles": ["scripts/supervise_job_events.py"],
            "metrics": None,
            "error": None,
            "rawResultPath": "/tmp/codex-retention-check.json",
        }

        first_code, first_output = supervise_job_events.process_event(event, state)
        supervise_job_events.trim_state(
            state,
            retention_days=30,
            max_jobs=10,
            max_dedupe_entries=10,
            now=datetime(2026, 4, 3, 12, 0, 0, tzinfo=timezone.utc),
        )
        second_code, second_output = supervise_job_events.process_event(event, state)

        self.assertEqual(0, first_code)
        self.assertEqual("notification-envelope-v1", first_output["schemaVersion"])
        self.assertEqual(3, second_code)
        self.assertEqual(
            {"suppressed": True, "reason": "duplicate-event", "eventKey": "codex|codex-retention-check|7"},
            second_output,
        )

    def test_process_event_rejects_invalid_contract_values(self):
        state = supervise_job_events.load_state(Path("/tmp/nonexistent-supervisor-state.json"))
        event = {
            "schemaVersion": "completion-event-v1",
            "source": "unknown-source",
            "jobId": "bad-source",
            "sequence": 1,
            "eventKind": "completion",
            "status": "succeeded",
            "observedAtUtc": "2026-04-03T11:00:00Z",
            "completedAtUtc": "2026-04-03T10:59:00Z",
            "summary": "Done",
            "progressPercent": None,
            "modifiedFiles": [],
            "metrics": None,
            "error": None,
            "rawResultPath": "/tmp/bad-source.json",
        }

        with self.assertRaisesRegex(ValueError, r"\$\.source: expected one of"):
            supervise_job_events.process_event(event, state)

    def test_process_event_rejects_out_of_range_progress_percent(self):
        state = supervise_job_events.load_state(Path("/tmp/nonexistent-supervisor-state.json"))
        event = {
            "schemaVersion": "completion-event-v1",
            "source": "gemini",
            "jobId": "bad-progress",
            "sequence": 2,
            "eventKind": "progress",
            "status": "running",
            "observedAtUtc": "2026-04-03T11:00:00Z",
            "completedAtUtc": None,
            "summary": "Working",
            "progressPercent": 130,
            "modifiedFiles": [],
            "metrics": None,
            "error": None,
            "rawResultPath": "/tmp/bad-progress.json",
        }

        with self.assertRaisesRegex(ValueError, r"\$\.progressPercent: expected value <= 100"):
            supervise_job_events.process_event(event, state)

    def test_adapt_gemini_result_validates_output_contract(self):
        raw_result = {
            "task_id": "gemini-bad",
            "status": "success",
            "completed_at": "2026-04-03T11:24:00Z",
            "summary": "ok",
            "modified_files": "not-a-list",
        }

        with self.assertRaisesRegex(ValueError, r"\$\.modifiedFiles: expected type array"):
            adapt_gemini_result.adapt_gemini_result(raw_result, Path("/tmp/gemini-bad.json"))

    def test_adapt_codex_result_validates_output_contract(self):
        raw_result = {
            "job_id": "codex-bad",
            "status": "success",
            "sequence": -1,
            "summary": "ok",
            "files_changed": [],
        }

        with self.assertRaisesRegex(ValueError, r"\$\.sequence: expected value >= 0"):
            adapt_codex_result.adapt_codex_result(raw_result, Path("/tmp/codex-bad.json"))

    def test_adapter_cli_rejects_invalid_json_without_traceback(self):
        scripts_dir = Path(__file__).resolve().parents[1] / "scripts"

        with tempfile.TemporaryDirectory() as temp_dir:
            invalid_path = Path(temp_dir) / "invalid.json"
            invalid_path.write_text("{not-json", encoding="utf-8")

            completed = subprocess.run(
                [
                    sys.executable,
                    str(scripts_dir / "adapt_gemini_result.py"),
                    "--raw-result-file",
                    str(invalid_path),
                ],
                check=False,
                capture_output=True,
                text=True,
            )

        self.assertEqual(2, completed.returncode)
        self.assertEqual("", completed.stderr)
        payload = json.loads(completed.stdout)
        self.assertEqual(str(invalid_path), payload["inputPath"])
        self.assertIn("Invalid JSON", payload["error"])

    def test_supervisor_cli_rejects_invalid_json_without_traceback(self):
        scripts_dir = Path(__file__).resolve().parents[1] / "scripts"

        with tempfile.TemporaryDirectory() as temp_dir:
            invalid_path = Path(temp_dir) / "invalid-event.json"
            state_path = Path(temp_dir) / "state.json"
            invalid_path.write_text("{not-json", encoding="utf-8")

            completed = subprocess.run(
                [
                    sys.executable,
                    str(scripts_dir / "supervise_job_events.py"),
                    "--event-file",
                    str(invalid_path),
                    "--state-file",
                    str(state_path),
                ],
                check=False,
                capture_output=True,
                text=True,
            )

        self.assertEqual(2, completed.returncode)
        self.assertEqual("", completed.stderr)
        payload = json.loads(completed.stdout)
        self.assertEqual(str(invalid_path), payload["inputPath"])
        self.assertIn("Invalid JSON", payload["error"])

    def test_dispatch_raw_result_detects_codex_and_updates_supervisor_state(self):
        scripts_dir = Path(__file__).resolve().parents[1] / "scripts"

        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "state.json"
            completed = subprocess.run(
                [
                    sys.executable,
                    str(scripts_dir / "dispatch_raw_result.py"),
                    "--raw-result-file",
                    str(Path(__file__).resolve().parents[1] / "samples" / "codex-result.raw.sample.json"),
                    "--state-file",
                    str(state_path),
                ],
                check=False,
                capture_output=True,
                text=True,
            )

            state_payload = json.loads(state_path.read_text(encoding="utf-8"))

        self.assertEqual(0, completed.returncode)
        self.assertEqual("", completed.stderr)
        payload = json.loads(completed.stdout)
        self.assertEqual("notification-envelope-v1", payload["schemaVersion"])
        self.assertEqual("codex", payload["source"])
        self.assertIn("codex-20260403-1452-adapter", state_payload["jobs"])

    def test_dispatch_raw_result_detects_gemini_and_suppresses_duplicates(self):
        scripts_dir = Path(__file__).resolve().parents[1] / "scripts"
        sample_path = Path(__file__).resolve().parents[1] / "samples" / "gemini-result.raw.sample.json"

        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = Path(temp_dir) / "state.json"
            first = subprocess.run(
                [
                    sys.executable,
                    str(scripts_dir / "dispatch_raw_result.py"),
                    "--raw-result-file",
                    str(sample_path),
                    "--state-file",
                    str(state_path),
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            second = subprocess.run(
                [
                    sys.executable,
                    str(scripts_dir / "dispatch_raw_result.py"),
                    "--raw-result-file",
                    str(sample_path),
                    "--state-file",
                    str(state_path),
                ],
                check=False,
                capture_output=True,
                text=True,
            )

        self.assertEqual(0, first.returncode)
        self.assertEqual("gemini", json.loads(first.stdout)["source"])
        self.assertEqual(3, second.returncode)
        self.assertEqual(
            {"suppressed": True, "reason": "duplicate-event", "eventKey": "gemini|gemini-queue-sample-001|2026-04-03T11:24:00Z|succeeded|%s" % sample_path},
            json.loads(second.stdout),
        )

    def test_dispatch_batch_archives_inputs_writes_notifications_and_consumer_drains_outbox(self):
        scripts_dir = Path(__file__).resolve().parents[1] / "scripts"
        samples_dir = Path(__file__).resolve().parents[1] / "samples"

        with tempfile.TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            inbox_dir = temp_root / "inbox"
            archive_dir = temp_root / "archive"
            error_dir = temp_root / "errors"
            notifications_dir = temp_root / "notifications"
            notifications_archive_dir = temp_root / "notifications-archive"
            state_path = temp_root / "state.json"

            inbox_dir.mkdir()
            shutil.copy2(samples_dir / "codex-result.raw.sample.json", inbox_dir / "codex-result.raw.sample.json")
            shutil.copy2(samples_dir / "gemini-result.raw.sample.json", inbox_dir / "gemini-result.raw.sample.json")
            (inbox_dir / "broken-result.json").write_text("{not-json", encoding="utf-8")

            dispatch_completed = subprocess.run(
                [
                    sys.executable,
                    str(scripts_dir / "dispatch_raw_result.py"),
                    "--raw-result-dir",
                    str(inbox_dir),
                    "--state-file",
                    str(state_path),
                    "--notifications-dir",
                    str(notifications_dir),
                    "--archive-dir",
                    str(archive_dir),
                    "--error-dir",
                    str(error_dir),
                ],
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(2, dispatch_completed.returncode)
            self.assertEqual("", dispatch_completed.stderr)
            dispatch_payload = json.loads(dispatch_completed.stdout)
            self.assertEqual(3, dispatch_payload["processedCount"])
            self.assertEqual([], list(inbox_dir.iterdir()))
            self.assertEqual(
                ["codex-result.raw.sample.ok.json", "gemini-result.raw.sample.ok.json"],
                sorted(path.name for path in archive_dir.iterdir()),
            )
            self.assertEqual(
                ["broken-result.error.json"],
                sorted(path.name for path in error_dir.iterdir()),
            )

            notification_files = sorted(notifications_dir.iterdir())
            self.assertEqual(2, len(notification_files))
            for notification_file in notification_files:
                envelope = json.loads(notification_file.read_text(encoding="utf-8"))
                self.assertEqual("notification-envelope-v1", envelope["schemaVersion"])

            consume_completed = subprocess.run(
                [
                    sys.executable,
                    str(scripts_dir / "consume_notifications.py"),
                    "--notifications-dir",
                    str(notifications_dir),
                    "--archive-dir",
                    str(notifications_archive_dir),
                ],
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(0, consume_completed.returncode)
            self.assertEqual("", consume_completed.stderr)
            consume_payload = json.loads(consume_completed.stdout)
            self.assertEqual(2, consume_payload["consumedCount"])
            self.assertEqual([], list(notifications_dir.iterdir()))
            self.assertEqual(2, len(list(notifications_archive_dir.iterdir())))

    def test_detect_raw_result_source_prefers_declared_source_for_ambiguous_payload(self):
        payload = {
            "source": "gemini",
            "status": "success",
            "job_id": "codex-looking",
            "task_id": "gemini-looking",
        }

        self.assertEqual("gemini", dispatch_raw_result.detect_raw_result_source(payload))

    def test_detect_raw_result_source_rejects_ambiguous_payload_without_declared_source(self):
        payload = {
            "status": "success",
            "job_id": "codex-looking",
            "task_id": "gemini-looking",
        }

        with self.assertRaisesRegex(ValueError, "Ambiguous raw result source"):
            dispatch_raw_result.detect_raw_result_source(payload)

    def test_detect_raw_result_source_rejects_unknown_payload(self):
        with self.assertRaisesRegex(ValueError, "Cannot detect raw result source"):
            dispatch_raw_result.detect_raw_result_source({"status": "success"})

    def test_resolve_default_raw_result_dir_points_to_gemini_queue_outbound(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            supervisor_root = temp_root / "job-supervisor"
            default_outbound_dir = temp_root / "gemini-queue" / "outbound"

            supervisor_root.mkdir()
            default_outbound_dir.mkdir(parents=True)

            self.assertEqual(
                default_outbound_dir,
                dispatch_raw_result.resolve_default_raw_result_dir(supervisor_root),
            )

    def test_write_codex_result_helper_and_dispatch_end_to_end(self):
        scripts_dir = Path(__file__).resolve().parents[1] / "scripts"

        with tempfile.TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            codex_outbound_dir = temp_root / "codex-queue" / "outbound"
            notifications_dir = temp_root / "notifications"
            archive_dir = temp_root / "archive"
            error_dir = temp_root / "errors"
            state_path = temp_root / "state.json"
            codex_outbound_dir.mkdir(parents=True)

            raw_result_path = codex_outbound_dir / "codex-live-helper.result.json"
            helper_completed = subprocess.run(
                [
                    sys.executable,
                    str(scripts_dir / "write_codex_result.py"),
                    "--job-id",
                    "codex-live-helper",
                    "--status",
                    "success",
                    "--summary",
                    "Codex helper smoke test",
                    "--completed-at",
                    "2026-04-03T20:57:00Z",
                    "--sequence",
                    "1",
                    "--files-changed",
                    ".openclaw/job-supervisor/scripts/write_codex_result.py,.openclaw/job-supervisor/README.md",
                    "--output",
                    str(raw_result_path),
                ],
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(0, helper_completed.returncode)
            self.assertEqual(str(raw_result_path), helper_completed.stdout.strip())
            raw_payload = json.loads(raw_result_path.read_text(encoding="utf-8"))
            self.assertEqual("codex-live-helper", raw_payload["job_id"])
            self.assertEqual("success", raw_payload["status"])

            dispatch_completed = subprocess.run(
                [
                    sys.executable,
                    str(scripts_dir / "dispatch_raw_result.py"),
                    "--raw-result-file",
                    str(raw_result_path),
                    "--state-file",
                    str(state_path),
                    "--notifications-dir",
                    str(notifications_dir),
                    "--archive-dir",
                    str(archive_dir),
                    "--error-dir",
                    str(error_dir),
                ],
                check=False,
                capture_output=True,
                text=True,
            )

            self.assertEqual(0, dispatch_completed.returncode)
            dispatch_payload = json.loads(dispatch_completed.stdout)
            self.assertEqual("notification-envelope-v1", dispatch_payload["schemaVersion"])
            self.assertEqual("codex", dispatch_payload["source"])
            self.assertEqual([], list(codex_outbound_dir.iterdir()))
            self.assertEqual(["codex-live-helper.result.ok.json"], [path.name for path in archive_dir.iterdir()])
            self.assertEqual([], list(error_dir.iterdir()) if error_dir.exists() else [])
            state_payload = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertIn("codex-live-helper", state_payload["jobs"])
            notification_files = list(notifications_dir.iterdir())
            self.assertEqual(1, len(notification_files))
            envelope = json.loads(notification_files[0].read_text(encoding="utf-8"))
            self.assertEqual("codex-live-helper", envelope["jobId"])


if __name__ == "__main__":
    unittest.main()

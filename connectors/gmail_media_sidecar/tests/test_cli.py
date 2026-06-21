from __future__ import annotations

import json
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path

from connectors.gmail_media_sidecar.cli import main

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "gmail"


class GmailMediaCliTests(unittest.TestCase):
    def test_dry_run_jsonl_is_deterministic_and_reports_counts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out1 = Path(tmp) / "run1.jsonl"
            out2 = Path(tmp) / "run2.jsonl"

            report1 = self._run_cli("dry-run-jsonl", "--fixtures", str(FIXTURES), "--out", str(out1))
            report2 = self._run_cli("dry-run-jsonl", "--fixtures", str(FIXTURES), "--out", str(out2))

            self.assertEqual(report1["parsed_count"], 10)
            self.assertEqual(report1["duplicate_count"], 1)
            self.assertEqual(report1["malformed_count"], 1)
            self.assertEqual(report1["failed_count"], 0)
            self.assertEqual(report1["written_count"], 9)
            self.assertEqual(out1.read_bytes(), out2.read_bytes())
            self.assertEqual(report1, report2)

            lines = out1.read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(lines), 9)
            first = json.loads(lines[0])
            self.assertEqual(first["schema_name"], "gmail_media_item")
            self.assertFalse(first["hostile_content"]["links_followed"])
            self.assertFalse(first["hostile_content"]["attachments_downloaded"])

    def test_checkpoint_skips_previously_written_records(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state = Path(tmp) / "state.json"
            out1 = Path(tmp) / "first.jsonl"
            out2 = Path(tmp) / "second.jsonl"

            first = self._run_cli(
                "dry-run-jsonl",
                "--fixtures",
                str(FIXTURES),
                "--out",
                str(out1),
                "--state",
                str(state),
            )
            second = self._run_cli(
                "dry-run-jsonl",
                "--fixtures",
                str(FIXTURES),
                "--out",
                str(out2),
                "--state",
                str(state),
            )

            self.assertEqual(first["written_count"], 9)
            self.assertEqual(second["written_count"], 0)
            self.assertEqual(second["skipped_count"], 9)
            self.assertEqual(second["duplicate_count"], 1)
            self.assertEqual(state.exists(), True)

    def test_backfill_requires_dry_run(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "backfill.jsonl"
            stdout = StringIO()
            stderr = StringIO()
            with self.assertRaises(SystemExit), redirect_stdout(stdout), redirect_stderr(stderr):
                main(["backfill", "--fixtures", str(FIXTURES), "--out", str(out)])
            self.assertIn("live Gmail backfill is disabled", stderr.getvalue())

    def _run_cli(self, *args: str) -> dict[str, object]:
        stdout = StringIO()
        with redirect_stdout(stdout):
            exit_code = main(list(args))
        self.assertEqual(exit_code, 0)
        return json.loads(stdout.getvalue())


if __name__ == "__main__":
    unittest.main()

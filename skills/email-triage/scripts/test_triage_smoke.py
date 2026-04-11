#!/usr/bin/env python3
"""Smoke test for the email-triage skill.

Unlike the unit tests in `test_triage.py`, this file exercises the full
skill as a black box:

- spawns `triage.py` in a real subprocess via the CLI entrypoints
  (`sync`, `pending`, `dismiss`),
- stands in a fake `main.py` for the external `email-ingest-integration`
  project that prints canned JSON,
- verifies state is persisted to disk and subsequent commands reflect it.

This catches regressions in:
  * argv dispatch (`if __name__ == "__main__"` branches)
  * subprocess invocation + JSON parsing
  * state file read/write round-trip
  * priority filtering end-to-end
  * dismiss ID coercion across process boundaries

Run with:  python -m pytest skills/email-triage/scripts/test_triage_smoke.py
or:        python skills/email-triage/scripts/test_triage_smoke.py
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
from unittest import TestCase, main

TRIAGE_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "triage.py")


# A minimal stand-in for the external email-ingest-integration CLI.
# Supports the three subcommands triage.py invokes:
#   - ``status`` (added in Anthrop-OS/email-ingest#18): reports init state
#   - ``ingest``: acknowledges and exits 0
#   - ``query --after-id N --format json``: returns canned rows
#
# The ``status`` response is controlled by the ``FAKE_STATUS_INITIALIZED``
# env var so tests can toggle first-run vs. normal behavior.
_FAKE_MAIN = r"""
import json
import os
import sys


def _read_inbox():
    path = os.environ.get("FAKE_INBOX_PATH")
    if not path or not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _meta_max_id(rows):
    ids = [r.get("id") for r in rows if isinstance(r, dict) and r.get("id") is not None]
    return max(ids) if ids else 0


def main():
    argv = sys.argv[1:]
    if not argv:
        print("usage: main.py <status|ingest|query>", file=sys.stderr)
        sys.exit(2)

    cmd = argv[0]

    if cmd == "status":
        initialized = os.environ.get("FAKE_STATUS_INITIALIZED", "1") != "0"
        payload = {
            "initialized": initialized,
            "accounts": [{"account_id": "fake", "last_uid": 1}] if initialized else [],
            "db_path": "/tmp/fake.sqlite",
        }
        print(json.dumps(payload))
        sys.exit(0)

    rows = _read_inbox()

    if cmd == "ingest":
        # Real CLI emits a status line; triage.py ignores ingest stdout.
        print(json.dumps({"ingested": len(rows)}))
        sys.exit(0)

    if cmd == "query":
        after_id = 0
        if "--after-id" in argv:
            try:
                after_id = int(argv[argv.index("--after-id") + 1])
            except (IndexError, ValueError):
                pass
        new_rows = [
            r for r in rows
            if isinstance(r, dict) and isinstance(r.get("id"), int) and r["id"] > after_id
        ]
        payload = {"results": new_rows, "meta": {"max_id": _meta_max_id(rows)}}
        print(json.dumps(payload))
        sys.exit(0)

    print(f"unknown command: {cmd}", file=sys.stderr)
    sys.exit(2)


if __name__ == "__main__":
    main()
"""


class TriageSmokeTest(TestCase):
    """End-to-end: real subprocess, real JSON, real filesystem."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp(prefix="triage-smoke-")
        self.workspace = os.path.join(self.tmpdir, "workspace")
        os.makedirs(self.workspace)

        # Fake main.py that triage will invoke via subprocess.
        self.fake_main_path = os.path.join(self.workspace, "main.py")
        with open(self.fake_main_path, "w", encoding="utf-8") as f:
            f.write(_FAKE_MAIN)

        self.state_path = os.path.join(self.tmpdir, "state.json")
        self.inbox_path = os.path.join(self.tmpdir, "inbox.json")

        # Environment shared by every subprocess call.
        self.env = os.environ.copy()
        self.env["EMAIL_TRIAGE_WORKSPACE"] = self.workspace
        self.env["EMAIL_TRIAGE_STATE"] = self.state_path
        # Use the current interpreter instead of $WORKSPACE/venv/bin/python3
        self.env["EMAIL_TRIAGE_VENV_PYTHON"] = sys.executable
        self.env["FAKE_INBOX_PATH"] = self.inbox_path
        # Default: fake status reports initialized=true so sync() takes the
        # steady-state branch. Individual tests override this to simulate
        # first-run.
        self.env["FAKE_STATUS_INITIALIZED"] = "1"

    def tearDown(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _write_inbox(self, rows):
        with open(self.inbox_path, "w", encoding="utf-8") as f:
            json.dump(rows, f)

    def _run(self, *args):
        return subprocess.run(
            [sys.executable, TRIAGE_SCRIPT, *args],
            env=self.env,
            capture_output=True,
            text=True,
            timeout=30,
        )

    def _load_state(self):
        with open(self.state_path, "r", encoding="utf-8") as f:
            return json.load(f)

    # -- scenarios ----------------------------------------------------------

    def test_sync_persists_state_and_filters_priority(self):
        self._write_inbox(
            [
                {"id": 1, "priority": "Urgent", "subject": "Fire", "sender": "a@b.com"},
                {"id": 2, "priority": "Low", "subject": "FYI", "sender": "c@d.com"},
                {"id": 3, "priority": "High", "subject": "Important", "sender": "e@f.com"},
            ]
        )

        result = self._run("sync")
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn("Sync complete", result.stdout)
        self.assertIn("enqueued 2", result.stdout)

        state = self._load_state()
        self.assertEqual(state["cursor"]["last_ingested_id"], 3)
        subjects = [item["subject"] for item in state["pending_attention"]]
        self.assertEqual(sorted(subjects), ["Fire", "Important"])
        # IDs must round-trip as strings (schema normalization).
        ids = [item["id"] for item in state["pending_attention"]]
        self.assertTrue(all(isinstance(i, str) for i in ids))

    def test_pending_command_lists_queue(self):
        self._write_inbox(
            [{"id": 9, "priority": "High", "subject": "Hi", "sender": "x@y.com"}]
        )
        self._run("sync")

        result = self._run("pending")
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        listed = json.loads(result.stdout)
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["id"], "9")
        self.assertEqual(listed[0]["subject"], "Hi")
        self.assertEqual(listed[0]["status"], "pending")

    def test_dismiss_removes_item_by_int_arg_against_str_stored_id(self):
        """Regression for review comment #11: pending IDs are stored as
        strings after normalization, but the user passes an int on the CLI.
        The dismiss path must match regardless of type."""
        self._write_inbox(
            [
                {"id": 10, "priority": "High", "subject": "A", "sender": "a@b.com"},
                {"id": 11, "priority": "High", "subject": "B", "sender": "c@d.com"},
            ]
        )
        self._run("sync")

        result = self._run("dismiss", "10")
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn("dismissed", result.stdout)

        state = self._load_state()
        self.assertEqual([i["id"] for i in state["pending_attention"]], ["11"])

    def test_dismiss_unknown_id(self):
        self._write_inbox(
            [{"id": 1, "priority": "High", "subject": "X", "sender": "x@y.com"}]
        )
        self._run("sync")

        result = self._run("dismiss", "9999")
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn("not found", result.stdout)

        state = self._load_state()
        self.assertEqual(len(state["pending_attention"]), 1)

    def test_sync_is_idempotent(self):
        """Running sync twice with the same inbox should not duplicate items
        (cursor advances; existing_ids dedup guards the second pass anyway)."""
        self._write_inbox(
            [{"id": 1, "priority": "High", "subject": "One", "sender": "a@b.com"}]
        )
        self._run("sync")
        self._run("sync")

        state = self._load_state()
        self.assertEqual(len(state["pending_attention"]), 1)
        self.assertEqual(state["cursor"]["last_ingested_id"], 1)

    def test_sync_appends_new_items_on_subsequent_call(self):
        self._write_inbox(
            [{"id": 1, "priority": "High", "subject": "First", "sender": "a@b.com"}]
        )
        self._run("sync")

        # Add a new row to the fake inbox.
        self._write_inbox(
            [
                {"id": 1, "priority": "High", "subject": "First", "sender": "a@b.com"},
                {"id": 2, "priority": "Critical", "subject": "Second", "sender": "c@d.com"},
            ]
        )
        self._run("sync")

        state = self._load_state()
        subjects = [i["subject"] for i in state["pending_attention"]]
        self.assertEqual(sorted(subjects), ["First", "Second"])
        self.assertEqual(state["cursor"]["last_ingested_id"], 2)

    def test_sync_handles_malformed_rows_without_crashing(self):
        """Regression for review comment #10: one bad row must not poison
        the whole sync. Valid rows after it should still be enqueued."""
        self._write_inbox(
            [
                None,  # not a dict
                {"id": 1, "priority": "High", "subject": "OK", "sender": "a@b.com"},
                "string-not-dict",
                {"priority": "High", "subject": "no id"},  # missing id
                {"id": 2, "priority": "Urgent", "subject": "Also OK", "sender": "c@d.com"},
            ]
        )

        result = self._run("sync")
        self.assertEqual(result.returncode, 0, msg=result.stderr)

        state = self._load_state()
        self.assertEqual(
            sorted(i["subject"] for i in state["pending_attention"]),
            ["Also OK", "OK"],
        )
        self.assertEqual(state["cursor"]["last_ingested_id"], 2)

    def test_sync_skips_init_start_date_when_status_initialized(self):
        """Regression test: when ``main.py status`` reports initialized=true,
        sync() must NOT pass ``--init-start-date`` on the subsequent ingest
        call (the upstream flag is 'mandatory on first run' and passing it
        on every run causes avalanche repair)."""
        # Instrument the fake main.py so we can see the full argv it
        # received. Wrap the existing fake with an argv logger.
        argv_log = os.path.join(self.tmpdir, "argv.log").replace("\\", "\\\\")
        wrapped = (
            "import os, sys\n"
            f"open(r'{argv_log}', 'a', encoding='utf-8').write(' '.join(sys.argv[1:]) + '\\n')\n"
            + _FAKE_MAIN
        )
        with open(self.fake_main_path, "w", encoding="utf-8") as f:
            f.write(wrapped)

        self.env["FAKE_STATUS_INITIALIZED"] = "1"
        self._write_inbox(
            [{"id": 1, "priority": "High", "subject": "X", "sender": "x@y.com"}]
        )

        result = self._run("sync")
        self.assertEqual(result.returncode, 0, msg=result.stderr)

        with open(argv_log.replace("\\\\", "\\"), "r", encoding="utf-8") as f:
            logged = f.read()
        ingest_line = next(
            line for line in logged.splitlines() if line.startswith("ingest")
        )
        self.assertNotIn("--init-start-date", ingest_line)

    def test_sync_passes_init_start_date_when_status_uninitialized(self):
        """Symmetric regression: when ``main.py status`` reports
        initialized=false, sync() MUST pass ``--init-start-date`` on ingest
        so the upstream's avalanche-protection guard does not trip."""
        argv_log = os.path.join(self.tmpdir, "argv.log").replace("\\", "\\\\")
        wrapped = (
            "import os, sys\n"
            f"open(r'{argv_log}', 'a', encoding='utf-8').write(' '.join(sys.argv[1:]) + '\\n')\n"
            + _FAKE_MAIN
        )
        with open(self.fake_main_path, "w", encoding="utf-8") as f:
            f.write(wrapped)

        self.env["FAKE_STATUS_INITIALIZED"] = "0"
        self._write_inbox([])

        result = self._run("sync")
        self.assertEqual(result.returncode, 0, msg=result.stderr)

        with open(argv_log.replace("\\\\", "\\"), "r", encoding="utf-8") as f:
            logged = f.read()
        ingest_line = next(
            line for line in logged.splitlines() if line.startswith("ingest")
        )
        self.assertIn("--init-start-date", ingest_line)

    def test_sync_handles_missing_workspace_gracefully(self):
        """If the workspace disappears between commands, sync must print a
        controlled error rather than exiting with a traceback."""
        shutil.rmtree(self.workspace)
        # Point VENV_PYTHON to a binary that cannot exist.
        self.env["EMAIL_TRIAGE_VENV_PYTHON"] = os.path.join(
            self.tmpdir, "nonexistent", "python"
        )

        result = self._run("sync")
        self.assertEqual(result.returncode, 0, msg=result.stderr)
        self.assertIn("Sync failed to start", result.stdout)
        self.assertNotIn("Traceback", result.stderr)


if __name__ == "__main__":
    main()

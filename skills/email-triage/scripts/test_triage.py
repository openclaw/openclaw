#!/usr/bin/env python3
"""Tests for email-triage triage helpers."""

import json
import os
import shutil
import sqlite3
import tempfile
from unittest import TestCase, main
from unittest.mock import patch

import triage


class TestIsHighPriority(TestCase):
    def test_string_high(self):
        self.assertTrue(triage._is_high_priority("High"))
        self.assertTrue(triage._is_high_priority("high"))
        self.assertTrue(triage._is_high_priority("HIGH"))

    def test_string_above_high(self):
        self.assertTrue(triage._is_high_priority("Urgent"))
        self.assertTrue(triage._is_high_priority("Critical"))

    def test_string_below_high(self):
        self.assertFalse(triage._is_high_priority("Low"))
        self.assertFalse(triage._is_high_priority("Normal"))
        self.assertFalse(triage._is_high_priority("Medium"))

    def test_string_unknown(self):
        self.assertFalse(triage._is_high_priority(""))
        self.assertFalse(triage._is_high_priority("other"))

    def test_numeric_at_threshold(self):
        self.assertTrue(triage._is_high_priority(3))
        self.assertTrue(triage._is_high_priority(4))
        self.assertTrue(triage._is_high_priority(5))

    def test_numeric_below_threshold(self):
        self.assertFalse(triage._is_high_priority(1))
        self.assertFalse(triage._is_high_priority(2))
        self.assertFalse(triage._is_high_priority(0))

    def test_numeric_float(self):
        self.assertTrue(triage._is_high_priority(3.5))
        self.assertFalse(triage._is_high_priority(2.9))


class TestState(TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.state_path = os.path.join(self.tmpdir, "sub", "state.json")
        self._patch = patch.object(triage, "STATE_PATH", self.state_path)
        self._patch.start()

    def tearDown(self):
        self._patch.stop()
        shutil.rmtree(self.tmpdir)

    def test_get_state_missing_file(self):
        state = triage.get_state()
        self.assertEqual(state["cursor"]["last_ingested_id"], 0)
        self.assertEqual(state["pending_attention"], [])

    def test_get_state_existing_file(self):
        os.makedirs(os.path.dirname(self.state_path), exist_ok=True)
        data = {"cursor": {"last_ingested_id": 42}, "pending_attention": [{"id": 1}]}
        with open(self.state_path, "w") as f:
            json.dump(data, f)
        state = triage.get_state()
        self.assertEqual(state["cursor"]["last_ingested_id"], 42)
        self.assertEqual(len(state["pending_attention"]), 1)

    def test_save_state_creates_dir(self):
        self.assertFalse(os.path.exists(os.path.dirname(self.state_path)))
        triage.save_state({"cursor": {"last_ingested_id": 0}, "pending_attention": []})
        self.assertTrue(os.path.exists(self.state_path))

    def test_save_state_roundtrip(self):
        data = {"cursor": {"last_ingested_id": 99}, "pending_attention": [{"id": 7}]}
        triage.save_state(data)
        loaded = triage.get_state()
        self.assertEqual(loaded, data)

    def test_get_state_corrupt_json(self):
        os.makedirs(os.path.dirname(self.state_path), exist_ok=True)
        with open(self.state_path, "w") as f:
            f.write("{bad json")
        state = triage.get_state()
        self.assertEqual(state["cursor"]["last_ingested_id"], 0)
        self.assertEqual(state["pending_attention"], [])

    def test_save_state_bare_filename(self):
        """save_state should work when STATE_PATH has no directory component."""
        bare_path = os.path.join(self.tmpdir, "state.json")
        with patch.object(triage, "STATE_PATH", bare_path):
            triage.save_state({"cursor": {"last_ingested_id": 0}, "pending_attention": []})
            self.assertTrue(os.path.exists(bare_path))


class TestCheckDb(TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.db_path = os.path.join(self.tmpdir, "test.sqlite")
        self._patch = patch.object(triage, "DB_PATH", self.db_path)
        self._patch.start()

    def tearDown(self):
        self._patch.stop()
        shutil.rmtree(self.tmpdir)

    def test_no_db_file(self):
        self.assertFalse(triage.check_db_initialized())

    def test_empty_db(self):
        conn = sqlite3.connect(self.db_path)
        conn.execute("CREATE TABLE email_accounts (id INTEGER PRIMARY KEY)")
        conn.commit()
        conn.close()
        self.assertFalse(triage.check_db_initialized())

    def test_initialized_db(self):
        conn = sqlite3.connect(self.db_path)
        conn.execute("CREATE TABLE email_accounts (id INTEGER PRIMARY KEY)")
        conn.execute("INSERT INTO email_accounts (id) VALUES (1)")
        conn.commit()
        conn.close()
        self.assertTrue(triage.check_db_initialized())

    def test_corrupt_db(self):
        with open(self.db_path, "w") as f:
            f.write("not a database")
        self.assertFalse(triage.check_db_initialized())


class TestPending(TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.state_path = os.path.join(self.tmpdir, "state.json")
        self._patch = patch.object(triage, "STATE_PATH", self.state_path)
        self._patch.start()

    def tearDown(self):
        self._patch.stop()
        shutil.rmtree(self.tmpdir)

    def test_pending_filters_status(self):
        triage.save_state(
            {
                "cursor": {"last_ingested_id": 0},
                "pending_attention": [
                    {"id": 1, "status": "pending"},
                    {"id": 2, "status": "notified"},
                    {"id": 3, "status": "pending"},
                ],
            }
        )
        state = triage.get_state()
        items = [i for i in state["pending_attention"] if i.get("status") == "pending"]
        self.assertEqual(len(items), 2)
        self.assertEqual([i["id"] for i in items], [1, 3])

    def test_pending_empty(self):
        triage.save_state({"cursor": {"last_ingested_id": 0}, "pending_attention": []})
        state = triage.get_state()
        items = [i for i in state["pending_attention"] if i.get("status") == "pending"]
        self.assertEqual(items, [])


class TestDismiss(TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.state_path = os.path.join(self.tmpdir, "state.json")
        self._patch = patch.object(triage, "STATE_PATH", self.state_path)
        self._patch.start()
        triage.save_state(
            {
                "cursor": {"last_ingested_id": 0},
                "pending_attention": [
                    {"id": 10, "status": "pending"},
                    {"id": 20, "status": "pending"},
                ],
            }
        )

    def tearDown(self):
        self._patch.stop()
        shutil.rmtree(self.tmpdir)

    def test_dismiss_existing(self):
        result = triage.dismiss(10)
        self.assertTrue(result)
        state = triage.get_state()
        self.assertEqual(len(state["pending_attention"]), 1)
        self.assertEqual(state["pending_attention"][0]["id"], 20)

    def test_dismiss_nonexistent(self):
        result = triage.dismiss(999)
        self.assertFalse(result)
        state = triage.get_state()
        self.assertEqual(len(state["pending_attention"]), 2)

    def test_dismiss_invalid_id(self):
        result = triage.dismiss("not-a-number")
        self.assertFalse(result)
        state = triage.get_state()
        self.assertEqual(len(state["pending_attention"]), 2)


class TestSync(TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.state_path = os.path.join(self.tmpdir, "state.json")
        self.db_path = os.path.join(self.tmpdir, "test.sqlite")
        self._patches = [
            patch.object(triage, "STATE_PATH", self.state_path),
            patch.object(triage, "DB_PATH", self.db_path),
            patch.object(triage, "WORKSPACE_DIR", self.tmpdir),
            patch.object(triage, "VENV_PYTHON", "python3"),
        ]
        for p in self._patches:
            p.start()

    def tearDown(self):
        for p in self._patches:
            p.stop()
        shutil.rmtree(self.tmpdir)

    @patch("triage.subprocess.run")
    def test_sync_first_run(self, mock_run):
        """When DB is not initialized, --init-start-date should be passed."""
        mock_run.return_value = type(
            "Result", (), {"returncode": 0, "stdout": '{"results":[],"meta":{}}', "stderr": ""}
        )()
        triage.sync()
        first_call_args = mock_run.call_args_list[0][0][0]
        self.assertIn("--init-start-date", first_call_args)

    @patch("triage.subprocess.run")
    def test_sync_updates_cursor(self, mock_run):
        """Cursor should advance to max_id from query results."""
        ingest_result = type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
        query_data = {
            "results": [
                {
                    "id": 5,
                    "subject": "Test",
                    "priority": "High",
                    "sender": "a@b.com",
                    "summary": "s",
                }
            ],
            "meta": {"max_id": 5},
        }
        query_result = type(
            "R", (), {"returncode": 0, "stdout": json.dumps(query_data), "stderr": ""}
        )()
        mock_run.side_effect = [ingest_result, query_result]

        triage.sync()

        state = triage.get_state()
        self.assertEqual(state["cursor"]["last_ingested_id"], 5)
        self.assertEqual(len(state["pending_attention"]), 1)
        self.assertEqual(state["pending_attention"][0]["subject"], "Test")

    @patch("triage.subprocess.run")
    def test_sync_filters_non_high_priority(self, mock_run):
        """Only emails with priority >= High should be enqueued."""
        ingest_result = type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
        query_data = {
            "results": [
                {"id": 1, "subject": "Fire", "priority": "Urgent", "sender": "a@b.com"},
                {"id": 2, "subject": "Important", "priority": "High", "sender": "b@c.com"},
                {"id": 3, "subject": "FYI", "priority": "Low", "sender": "c@d.com"},
                {"id": 4, "subject": "Normal", "priority": "Normal", "sender": "e@f.com"},
                {"id": 5, "subject": "Meltdown", "priority": "Critical", "sender": "f@g.com"},
            ],
            "meta": {"max_id": 5},
        }
        query_result = type(
            "R", (), {"returncode": 0, "stdout": json.dumps(query_data), "stderr": ""}
        )()
        mock_run.side_effect = [ingest_result, query_result]

        triage.sync()

        state = triage.get_state()
        subjects = [item["subject"] for item in state["pending_attention"]]
        self.assertEqual(subjects, ["Fire", "Important", "Meltdown"])

    @patch("triage.subprocess.run")
    def test_sync_numeric_priority(self, mock_run):
        """Numeric priorities >= 3 (High) should be enqueued."""
        ingest_result = type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
        query_data = {
            "results": [
                {"id": 1, "subject": "P4", "priority": 4, "sender": "a@b.com"},
                {"id": 2, "subject": "P3", "priority": 3, "sender": "b@c.com"},
                {"id": 3, "subject": "P2", "priority": 2, "sender": "c@d.com"},
                {"id": 4, "subject": "P1", "priority": 1, "sender": "d@e.com"},
            ],
            "meta": {"max_id": 4},
        }
        query_result = type(
            "R", (), {"returncode": 0, "stdout": json.dumps(query_data), "stderr": ""}
        )()
        mock_run.side_effect = [ingest_result, query_result]

        triage.sync()

        state = triage.get_state()
        subjects = [item["subject"] for item in state["pending_attention"]]
        self.assertEqual(subjects, ["P4", "P3"])

    @patch("triage.subprocess.run")
    def test_sync_bad_json(self, mock_run):
        """Sync should not crash on malformed JSON output."""
        ingest_result = type("R", (), {"returncode": 0, "stdout": "", "stderr": ""})()
        query_result = type(
            "R", (), {"returncode": 0, "stdout": "not json", "stderr": ""}
        )()
        mock_run.side_effect = [ingest_result, query_result]

        # Should print error, not raise
        triage.sync()

    @patch("triage.subprocess.run")
    def test_sync_missing_workspace(self, mock_run):
        """Sync should handle missing workspace/venv gracefully."""
        mock_run.side_effect = FileNotFoundError("No such file or directory: 'python3'")

        # Should print error, not raise
        triage.sync()


if __name__ == "__main__":
    main()

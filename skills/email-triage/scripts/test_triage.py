#!/usr/bin/env python3
"""Tests for email-triage triage helpers."""

import json
import os
import shutil
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


class TestPendingItemFromDict(TestCase):
    def test_valid_dict(self):
        item = triage.PendingItem.from_dict(
            {"id": 42, "subject": "Hi", "sender": "a@b.com", "priority": "High"}
        )
        self.assertIsNotNone(item)
        self.assertEqual(item.id, "42")  # normalized to str
        self.assertEqual(item.subject, "Hi")
        self.assertEqual(item.status, "pending")  # default

    def test_non_dict_returns_none(self):
        self.assertIsNone(triage.PendingItem.from_dict(None))
        self.assertIsNone(triage.PendingItem.from_dict(1))
        self.assertIsNone(triage.PendingItem.from_dict("string"))
        self.assertIsNone(triage.PendingItem.from_dict([1, 2]))

    def test_missing_id_returns_none(self):
        self.assertIsNone(triage.PendingItem.from_dict({}))
        self.assertIsNone(triage.PendingItem.from_dict({"subject": "no id"}))
        self.assertIsNone(triage.PendingItem.from_dict({"id": None}))

    def test_id_coerced_to_str(self):
        self.assertEqual(triage.PendingItem.from_dict({"id": 10}).id, "10")
        self.assertEqual(triage.PendingItem.from_dict({"id": "10"}).id, "10")
        self.assertEqual(triage.PendingItem.from_dict({"id": "abc-123"}).id, "abc-123")


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
        self.assertEqual(state.cursor.last_ingested_id, 0)
        self.assertEqual(state.pending_attention, [])

    def test_get_state_existing_file(self):
        os.makedirs(os.path.dirname(self.state_path), exist_ok=True)
        data = {"cursor": {"last_ingested_id": 42}, "pending_attention": [{"id": 1}]}
        with open(self.state_path, "w", encoding="utf-8") as f:
            json.dump(data, f)
        state = triage.get_state()
        self.assertEqual(state.cursor.last_ingested_id, 42)
        self.assertEqual(len(state.pending_attention), 1)
        self.assertEqual(state.pending_attention[0].id, "1")

    def test_save_state_creates_dir(self):
        self.assertFalse(os.path.exists(os.path.dirname(self.state_path)))
        triage.save_state(triage.State())
        self.assertTrue(os.path.exists(self.state_path))

    def test_save_state_roundtrip(self):
        orig = triage.State(
            cursor=triage.Cursor(last_ingested_id=99),
            pending_attention=[triage.PendingItem(id="7", subject="hello")],
        )
        triage.save_state(orig)
        loaded = triage.get_state()
        self.assertEqual(loaded.cursor.last_ingested_id, 99)
        self.assertEqual(len(loaded.pending_attention), 1)
        self.assertEqual(loaded.pending_attention[0].id, "7")
        self.assertEqual(loaded.pending_attention[0].subject, "hello")

    def test_get_state_corrupt_json(self):
        os.makedirs(os.path.dirname(self.state_path), exist_ok=True)
        with open(self.state_path, "w", encoding="utf-8") as f:
            f.write("{bad json")
        state = triage.get_state()
        self.assertEqual(state.cursor.last_ingested_id, 0)
        self.assertEqual(state.pending_attention, [])

    def test_get_state_empty_object(self):
        os.makedirs(os.path.dirname(self.state_path), exist_ok=True)
        with open(self.state_path, "w", encoding="utf-8") as f:
            json.dump({}, f)
        state = triage.get_state()
        self.assertEqual(state.cursor.last_ingested_id, 0)
        self.assertEqual(state.pending_attention, [])

    def test_get_state_missing_cursor(self):
        os.makedirs(os.path.dirname(self.state_path), exist_ok=True)
        with open(self.state_path, "w", encoding="utf-8") as f:
            json.dump({"pending_attention": [{"id": 1}]}, f)
        state = triage.get_state()
        self.assertEqual(state.cursor.last_ingested_id, 0)
        self.assertEqual(len(state.pending_attention), 1)
        self.assertEqual(state.pending_attention[0].id, "1")

    def test_get_state_missing_pending(self):
        os.makedirs(os.path.dirname(self.state_path), exist_ok=True)
        with open(self.state_path, "w", encoding="utf-8") as f:
            json.dump({"cursor": {"last_ingested_id": 10}}, f)
        state = triage.get_state()
        self.assertEqual(state.cursor.last_ingested_id, 10)
        self.assertEqual(state.pending_attention, [])

    def test_get_state_non_dict(self):
        os.makedirs(os.path.dirname(self.state_path), exist_ok=True)
        with open(self.state_path, "w", encoding="utf-8") as f:
            json.dump([1, 2, 3], f)
        state = triage.get_state()
        self.assertEqual(state.cursor.last_ingested_id, 0)
        self.assertEqual(state.pending_attention, [])

    def test_get_state_pending_filters_non_dict_entries(self):
        os.makedirs(os.path.dirname(self.state_path), exist_ok=True)
        with open(self.state_path, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "cursor": {"last_ingested_id": 0},
                    "pending_attention": [
                        {"id": 1, "status": "pending"},
                        1,
                        "not a dict",
                        None,
                        [1, 2],
                        {"id": 2, "status": "pending"},
                    ],
                },
                f,
            )
        state = triage.get_state()
        self.assertEqual([i.id for i in state.pending_attention], ["1", "2"])

    def test_get_state_pending_filters_dict_without_id(self):
        os.makedirs(os.path.dirname(self.state_path), exist_ok=True)
        with open(self.state_path, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "cursor": {"last_ingested_id": 0},
                    "pending_attention": [
                        {},
                        {"subject": "no id"},
                        {"id": 5, "subject": "ok"},
                    ],
                },
                f,
            )
        state = triage.get_state()
        self.assertEqual(len(state.pending_attention), 1)
        self.assertEqual(state.pending_attention[0].id, "5")

    def test_save_state_bare_filename(self):
        """save_state should work when STATE_PATH has no directory component."""
        bare_path = os.path.join(self.tmpdir, "state.json")
        with patch.object(triage, "STATE_PATH", bare_path):
            triage.save_state(triage.State())
            self.assertTrue(os.path.exists(bare_path))

    def test_get_state_cursor_non_int(self):
        """Cursor with non-int last_ingested_id should fall back to 0."""
        os.makedirs(os.path.dirname(self.state_path), exist_ok=True)
        with open(self.state_path, "w", encoding="utf-8") as f:
            json.dump({"cursor": {"last_ingested_id": "not an int"}}, f)
        state = triage.get_state()
        self.assertEqual(state.cursor.last_ingested_id, 0)

    def test_save_state_utf8(self):
        """State file must be written as UTF-8 (not platform default)."""
        os.makedirs(os.path.dirname(self.state_path), exist_ok=True)
        triage.save_state(
            triage.State(
                pending_attention=[
                    triage.PendingItem(id="1", subject="你好 — привет — مرحبا")
                ]
            )
        )
        with open(self.state_path, "rb") as f:
            raw = f.read()
        # Should contain the UTF-8 bytes, not be garbled
        self.assertIn("你好".encode("utf-8"), raw)
        loaded = triage.get_state()
        self.assertEqual(loaded.pending_attention[0].subject, "你好 — привет — مرحبا")


class TestCheckDb(TestCase):
    """Tests for check_db_initialized().

    This helper used to ``sqlite3.connect()`` the upstream DB and run a
    hardcoded query against a table name that had been confused with a
    config.yaml key. The first version queried ``email_accounts`` which
    does not exist as a SQLite table — every call raised
    ``OperationalError``, was swallowed by a broad ``except``, and the
    function always returned False, so every sync wrongly appended
    ``--init-start-date yesterday``.

    The current implementation shells out to ``main.py status`` (added
    in Anthrop-OS/email-ingest#18) so the skill never opens the SQLite
    file directly. These tests exercise every branch of the new flow.
    """

    @patch("triage.subprocess.run")
    def test_initialized_true_when_status_says_so(self, mock_run):
        mock_run.return_value = type(
            "R",
            (),
            {
                "returncode": 0,
                "stdout": json.dumps(
                    {
                        "initialized": True,
                        "accounts": [{"account_id": "a", "last_uid": 10}],
                        "db_path": "/tmp/db.sqlite",
                    }
                ),
                "stderr": "",
            },
        )()
        self.assertTrue(triage.check_db_initialized())

    @patch("triage.subprocess.run")
    def test_initialized_false_when_status_empty(self, mock_run):
        mock_run.return_value = type(
            "R",
            (),
            {
                "returncode": 0,
                "stdout": json.dumps(
                    {"initialized": False, "accounts": [], "db_path": "/tmp/db.sqlite"}
                ),
                "stderr": "",
            },
        )()
        self.assertFalse(triage.check_db_initialized())

    @patch("triage.subprocess.run")
    def test_initialized_false_on_nonzero_exit(self, mock_run):
        mock_run.return_value = type(
            "R", (), {"returncode": 1, "stdout": "", "stderr": "config missing"}
        )()
        self.assertFalse(triage.check_db_initialized())

    @patch("triage.subprocess.run")
    def test_initialized_false_on_timeout(self, mock_run):
        import subprocess as sp

        mock_run.side_effect = sp.TimeoutExpired(cmd="main.py", timeout=30)
        self.assertFalse(triage.check_db_initialized())

    @patch("triage.subprocess.run")
    def test_initialized_false_on_missing_workspace(self, mock_run):
        mock_run.side_effect = FileNotFoundError("no such file: python3")
        self.assertFalse(triage.check_db_initialized())

    @patch("triage.subprocess.run")
    def test_initialized_false_on_bad_json(self, mock_run):
        mock_run.return_value = type(
            "R", (), {"returncode": 0, "stdout": "not json", "stderr": ""}
        )()
        self.assertFalse(triage.check_db_initialized())

    @patch("triage.subprocess.run")
    def test_initialized_false_when_key_missing(self, mock_run):
        """Valid JSON without an ``initialized`` key must be treated as not
        initialized (defensive against upstream schema drift)."""
        mock_run.return_value = type(
            "R", (), {"returncode": 0, "stdout": json.dumps({"accounts": []}), "stderr": ""}
        )()
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
            triage.State(
                pending_attention=[
                    triage.PendingItem(id="1", status="pending"),
                    triage.PendingItem(id="2", status="notified"),
                    triage.PendingItem(id="3", status="pending"),
                ]
            )
        )
        state = triage.get_state()
        items = [i for i in state.pending_attention if i.status == "pending"]
        self.assertEqual(len(items), 2)
        self.assertEqual([i.id for i in items], ["1", "3"])

    def test_pending_empty(self):
        triage.save_state(triage.State())
        state = triage.get_state()
        items = [i for i in state.pending_attention if i.status == "pending"]
        self.assertEqual(items, [])


class TestDismiss(TestCase):
    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.state_path = os.path.join(self.tmpdir, "state.json")
        self._patch = patch.object(triage, "STATE_PATH", self.state_path)
        self._patch.start()
        triage.save_state(
            triage.State(
                pending_attention=[
                    triage.PendingItem(id="10", status="pending"),
                    triage.PendingItem(id="20", status="pending"),
                ]
            )
        )

    def tearDown(self):
        self._patch.stop()
        shutil.rmtree(self.tmpdir)

    def test_dismiss_existing(self):
        result = triage.dismiss(10)
        self.assertTrue(result)
        state = triage.get_state()
        self.assertEqual(len(state.pending_attention), 1)
        self.assertEqual(state.pending_attention[0].id, "20")

    def test_dismiss_nonexistent(self):
        result = triage.dismiss(999)
        self.assertFalse(result)
        state = triage.get_state()
        self.assertEqual(len(state.pending_attention), 2)

    def test_dismiss_invalid_id(self):
        # Non-numeric id is accepted now (IDs are strings), but has no match
        result = triage.dismiss("not-a-number")
        self.assertFalse(result)
        state = triage.get_state()
        self.assertEqual(len(state.pending_attention), 2)

    def test_dismiss_none(self):
        result = triage.dismiss(None)
        self.assertFalse(result)

    def test_dismiss_int_matches_string_stored(self):
        """Regression test for review comment #11: int arg should match str-stored id."""
        result = triage.dismiss(10)  # int arg
        self.assertTrue(result)
        state = triage.get_state()
        self.assertEqual([i.id for i in state.pending_attention], ["20"])


def _stub_result(returncode=0, stdout="", stderr=""):
    return type(
        "R", (), {"returncode": returncode, "stdout": stdout, "stderr": stderr}
    )()


def _status_stub(initialized: bool):
    """Stubbed ``main.py status`` JSON response."""
    return _stub_result(
        stdout=json.dumps(
            {
                "initialized": initialized,
                "accounts": [{"account_id": "a", "last_uid": 1}] if initialized else [],
                "db_path": "/tmp/fake.sqlite",
            }
        )
    )


class TestSync(TestCase):
    """Each sync() call now makes 3 subprocess invocations:
        1. status   (check_db_initialized)
        2. ingest
        3. query
    so every side_effect list must provide 3 elements in that order.
    """

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.state_path = os.path.join(self.tmpdir, "state.json")
        self._patches = [
            patch.object(triage, "STATE_PATH", self.state_path),
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
        """When status reports not-initialized, --init-start-date must be
        passed on the subsequent ingest call."""
        empty_query = _stub_result(stdout='{"results":[],"meta":{}}')
        mock_run.side_effect = [
            _status_stub(initialized=False),
            _stub_result(),  # ingest
            empty_query,
        ]
        triage.sync()
        # call_args_list[0] is status, [1] is ingest
        ingest_call_args = mock_run.call_args_list[1][0][0]
        self.assertIn("--init-start-date", ingest_call_args)

    @patch("triage.subprocess.run")
    def test_sync_initialized_skips_init_start_date(self, mock_run):
        """When status reports initialized=true, ingest must NOT receive
        --init-start-date."""
        empty_query = _stub_result(stdout='{"results":[],"meta":{}}')
        mock_run.side_effect = [
            _status_stub(initialized=True),
            _stub_result(),  # ingest
            empty_query,
        ]
        triage.sync()
        ingest_call_args = mock_run.call_args_list[1][0][0]
        self.assertNotIn("--init-start-date", ingest_call_args)

    @patch("triage.subprocess.run")
    def test_sync_updates_cursor(self, mock_run):
        """Cursor should advance to max_id from query results."""
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
        mock_run.side_effect = [
            _status_stub(initialized=True),
            _stub_result(),  # ingest
            _stub_result(stdout=json.dumps(query_data)),  # query
        ]

        triage.sync()

        state = triage.get_state()
        self.assertEqual(state.cursor.last_ingested_id, 5)
        self.assertEqual(len(state.pending_attention), 1)
        self.assertEqual(state.pending_attention[0].subject, "Test")
        self.assertEqual(state.pending_attention[0].id, "5")

    @patch("triage.subprocess.run")
    def test_sync_filters_non_high_priority(self, mock_run):
        """Only emails with priority >= High should be enqueued."""
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
        mock_run.side_effect = [
            _status_stub(initialized=True),
            _stub_result(),
            _stub_result(stdout=json.dumps(query_data)),
        ]

        triage.sync()

        state = triage.get_state()
        subjects = [item.subject for item in state.pending_attention]
        self.assertEqual(subjects, ["Fire", "Important", "Meltdown"])

    @patch("triage.subprocess.run")
    def test_sync_numeric_priority(self, mock_run):
        """Numeric priorities >= 3 (High) should be enqueued."""
        query_data = {
            "results": [
                {"id": 1, "subject": "P4", "priority": 4, "sender": "a@b.com"},
                {"id": 2, "subject": "P3", "priority": 3, "sender": "b@c.com"},
                {"id": 3, "subject": "P2", "priority": 2, "sender": "c@d.com"},
                {"id": 4, "subject": "P1", "priority": 1, "sender": "d@e.com"},
            ],
            "meta": {"max_id": 4},
        }
        mock_run.side_effect = [
            _status_stub(initialized=True),
            _stub_result(),
            _stub_result(stdout=json.dumps(query_data)),
        ]

        triage.sync()

        state = triage.get_state()
        subjects = [item.subject for item in state.pending_attention]
        self.assertEqual(subjects, ["P4", "P3"])

    @patch("triage.subprocess.run")
    def test_sync_bad_json(self, mock_run):
        """Sync should not crash on malformed JSON output."""
        mock_run.side_effect = [
            _status_stub(initialized=True),
            _stub_result(),
            _stub_result(stdout="not json"),
        ]
        triage.sync()  # must not raise

    @patch("triage.subprocess.run")
    def test_sync_missing_workspace(self, mock_run):
        """Sync should handle missing workspace/venv gracefully.

        Note: status also uses subprocess.run, so a FileNotFoundError on
        the very first call causes check_db_initialized() to return False
        and the subsequent ingest call raises the same error, which
        sync()'s OSError handler catches.
        """
        mock_run.side_effect = FileNotFoundError("No such file or directory: 'python3'")
        triage.sync()  # must not raise

    @patch("triage.subprocess.run")
    def test_sync_skips_malformed_rows(self, mock_run):
        """Regression test for review comment #10: non-dict or shape-invalid
        rows must be skipped, not crash the whole sync."""
        query_data = {
            "results": [
                None,  # non-dict entry
                "string",  # non-dict entry
                {"priority": "High"},  # missing id
                {"id": 1, "priority": "High", "subject": "Good"},  # valid high
                {"id": 2, "priority": "Low"},  # filtered by priority
                42,  # non-dict entry
            ],
            "meta": {"max_id": 2},
        }
        mock_run.side_effect = [
            _status_stub(initialized=True),
            _stub_result(),
            _stub_result(stdout=json.dumps(query_data)),
        ]

        triage.sync()  # must not raise

        state = triage.get_state()
        self.assertEqual([i.id for i in state.pending_attention], ["1"])
        self.assertEqual(state.cursor.last_ingested_id, 2)

    @patch("triage.subprocess.run")
    def test_sync_dedupes(self, mock_run):
        """Subsequent sync calls must not duplicate an already-queued item."""
        query_data = {
            "results": [
                {"id": 7, "priority": "High", "subject": "dup", "sender": "x@y.com"},
            ],
            "meta": {"max_id": 7},
        }
        query_stub = _stub_result(stdout=json.dumps(query_data))
        # Two sync calls; each makes 3 subprocess invocations
        # (status + ingest + query) = 6 total.
        mock_run.side_effect = [
            _status_stub(initialized=True),
            _stub_result(),
            query_stub,
            _status_stub(initialized=True),
            _stub_result(),
            query_stub,
        ]

        triage.sync()
        triage.sync()

        state = triage.get_state()
        self.assertEqual(len(state.pending_attention), 1)


if __name__ == "__main__":
    main()

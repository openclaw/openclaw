"""
Tests for the Python state logic used in:
  - bodhi-checkin (checkin-state.json, vault node write)
  - bodhi-tasks (tasks-life.json CRUD)
  - bodhi-calendar (UID validation, endpoint allowlist)
  - bodhi-accountability (commitments, streak tracking)

These tests replicate the logic from SKILL.md Python snippets
to verify correctness before deploying to bodhi1.
"""

import json
import os
import re
import tempfile
import uuid
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def atomic_write(path: Path, data: dict) -> None:
    """Atomic JSON write — mirrors the tempfile+os.replace pattern in skills."""
    tmp = tempfile.NamedTemporaryFile(
        mode="w", dir=path.parent, suffix=".tmp", delete=False
    )
    json.dump(data, tmp)
    tmp.close()
    os.replace(tmp.name, str(path))


def read_json(path: Path) -> dict:
    return json.loads(path.read_text()) if path.exists() else {}


# ---------------------------------------------------------------------------
# bodhi-checkin: checkin-state.json logic
# ---------------------------------------------------------------------------

class TestCheckinStreak:
    def _make_state(self, tmp_path) -> Path:
        p = tmp_path / "checkin-state.json"
        atomic_write(p, {
            "morning_streak": 0, "evening_streak": 0,
            "last_morning": None, "last_evening": None
        })
        return p

    def _bump_morning(self, state_path: Path, today_str: str) -> int:
        state = read_json(state_path) or {
            "morning_streak": 0, "evening_streak": 0,
            "last_morning": None, "last_evening": None
        }
        yesterday = (date.fromisoformat(today_str) - timedelta(days=1)).isoformat()
        last = state.get("last_morning")
        if last == yesterday:
            state["morning_streak"] = state.get("morning_streak", 0) + 1
        elif last != today_str:
            state["morning_streak"] = 1
        state["last_morning"] = today_str
        atomic_write(state_path, state)
        return state["morning_streak"]

    def test_first_checkin_sets_streak_1(self, tmp_path):
        p = self._make_state(tmp_path)
        streak = self._bump_morning(p, "2026-03-15")
        assert streak == 1

    def test_consecutive_days_increment_streak(self, tmp_path):
        p = self._make_state(tmp_path)
        self._bump_morning(p, "2026-03-14")
        streak = self._bump_morning(p, "2026-03-15")
        assert streak == 2

    def test_missed_day_resets_streak(self, tmp_path):
        p = self._make_state(tmp_path)
        self._bump_morning(p, "2026-03-13")  # day 1
        streak = self._bump_morning(p, "2026-03-15")  # skipped 14
        assert streak == 1

    def test_same_day_double_checkin_does_not_increment(self, tmp_path):
        p = self._make_state(tmp_path)
        self._bump_morning(p, "2026-03-15")
        # Simulate calling again same day
        state = read_json(p)
        last = state.get("last_morning")
        today = "2026-03-15"
        yesterday = (date.fromisoformat(today) - timedelta(days=1)).isoformat()
        if last == yesterday:
            state["morning_streak"] += 1
        elif last != today:
            state["morning_streak"] = 1
        # last == today → no change
        assert state["morning_streak"] == 1

    def test_five_day_streak(self, tmp_path):
        p = self._make_state(tmp_path)
        base = date(2026, 3, 10)
        for i in range(5):
            day = (base + timedelta(days=i)).isoformat()
            streak = self._bump_morning(p, day)
        assert streak == 5

    def test_atomic_write_produces_valid_json(self, tmp_path):
        p = tmp_path / "checkin-state.json"
        state = {"morning_streak": 7, "last_morning": "2026-03-15"}
        atomic_write(p, state)
        loaded = read_json(p)
        assert loaded["morning_streak"] == 7

    def test_missing_state_file_starts_fresh(self, tmp_path):
        p = tmp_path / "checkin-state.json"
        streak = self._bump_morning(p, "2026-03-15")
        assert streak == 1


# ---------------------------------------------------------------------------
# bodhi-tasks: tasks-life.json CRUD
# ---------------------------------------------------------------------------

VALID_TASK_ID_PATTERN = re.compile(r'^[a-f0-9]{8}$')


def make_task(text: str, due: str = None, priority: str = "normal") -> dict:
    return {
        "id": str(uuid.uuid4())[:8],
        "text": text[:500],
        "status": "open",
        "priority": priority,
        "due": due,
        "created_at": datetime.now().isoformat(),
        "completed_at": None,
        "tags": []
    }


class TestTasksCRUD:
    def test_task_id_format(self):
        for _ in range(20):
            t = make_task("test")
            assert VALID_TASK_ID_PATTERN.match(t["id"]), f"Bad ID: {t['id']}"

    def test_task_text_truncated_at_500(self):
        long_text = "x" * 600
        t = make_task(long_text)
        assert len(t["text"]) == 500

    def test_task_id_validation_accepts_valid(self):
        assert VALID_TASK_ID_PATTERN.match("a1b2c3d4")
        assert VALID_TASK_ID_PATTERN.match("00000000")
        assert VALID_TASK_ID_PATTERN.match("ffffffff")

    def test_task_id_validation_rejects_invalid(self):
        assert not VALID_TASK_ID_PATTERN.match("")
        assert not VALID_TASK_ID_PATTERN.match("ABCDEFGH")   # uppercase
        assert not VALID_TASK_ID_PATTERN.match("a1b2c3d")    # 7 chars
        assert not VALID_TASK_ID_PATTERN.match("a1b2c3d4e")  # 9 chars
        assert not VALID_TASK_ID_PATTERN.match("../../etc")  # path traversal
        assert not VALID_TASK_ID_PATTERN.match("a1b2;ls")    # injection

    def test_add_task_to_state(self, tmp_path):
        p = tmp_path / "tasks-life.json"
        data = {"tasks": []}
        t = make_task("call the doctor", due="2026-03-16")
        data["tasks"].append(t)
        atomic_write(p, data)
        loaded = read_json(p)
        assert len(loaded["tasks"]) == 1
        assert loaded["tasks"][0]["text"] == "call the doctor"

    def test_mark_done(self, tmp_path):
        p = tmp_path / "tasks-life.json"
        t = make_task("fix the dryer")
        data = {"tasks": [t]}
        atomic_write(p, data)

        loaded = read_json(p)
        for task in loaded["tasks"]:
            if task["id"] == t["id"]:
                task["status"] = "done"
                task["completed_at"] = datetime.now().isoformat()
        atomic_write(p, loaded)

        final = read_json(p)
        assert final["tasks"][0]["status"] == "done"
        assert final["tasks"][0]["completed_at"] is not None

    def test_snooze_sets_due_date(self, tmp_path):
        p = tmp_path / "tasks-life.json"
        t = make_task("pay bill", due="2026-03-15")
        data = {"tasks": [t]}
        atomic_write(p, data)

        new_due = (date.fromisoformat("2026-03-15") + timedelta(days=1)).isoformat()
        loaded = read_json(p)
        for task in loaded["tasks"]:
            if task["id"] == t["id"]:
                task["due"] = new_due
        atomic_write(p, loaded)

        final = read_json(p)
        assert final["tasks"][0]["due"] == "2026-03-16"

    def test_invalid_priority_rejected(self):
        valid = {"high", "normal", "low"}
        assert "high" in valid
        assert "critical" not in valid
        assert "urgent" not in valid

    def test_overdue_detection(self):
        today = "2026-03-15"
        tasks = [
            {"text": "overdue", "due": "2026-03-10", "status": "open"},
            {"text": "today", "due": "2026-03-15", "status": "open"},
            {"text": "future", "due": "2026-03-20", "status": "open"},
            {"text": "no due", "due": None, "status": "open"},
        ]
        overdue = [t for t in tasks if t["due"] and t["due"] < today]
        due_today = [t for t in tasks if t["due"] == today]
        upcoming = [t for t in tasks if t["due"] and t["due"] > today]
        no_due = [t for t in tasks if not t["due"]]

        assert len(overdue) == 1
        assert len(due_today) == 1
        assert len(upcoming) == 1
        assert len(no_due) == 1

    def test_clear_moves_done_to_archive(self, tmp_path):
        p = tmp_path / "tasks-life.json"
        archive_p = tmp_path / "tasks-life-archive.json"
        tasks = [
            make_task("done task"),
            make_task("open task")
        ]
        tasks[0]["status"] = "done"
        data = {"tasks": tasks}
        atomic_write(p, data)

        loaded = read_json(p)
        done = [t for t in loaded["tasks"] if t["status"] == "done"]
        open_tasks = [t for t in loaded["tasks"] if t["status"] == "open"]

        archive = read_json(archive_p) or {"tasks": []}
        archive["tasks"].extend(done)
        atomic_write(archive_p, archive)
        loaded["tasks"] = open_tasks
        atomic_write(p, loaded)

        final = read_json(p)
        final_archive = read_json(archive_p)
        assert len(final["tasks"]) == 1
        assert final["tasks"][0]["status"] == "open"
        assert len(final_archive["tasks"]) == 1
        assert final_archive["tasks"][0]["status"] == "done"


# ---------------------------------------------------------------------------
# bodhi-calendar: UID and endpoint validation
# ---------------------------------------------------------------------------

UID_PATTERN = re.compile(r'^[a-zA-Z0-9_-]{1,64}$')
ALLOWED_ENDPOINTS = {'bookings', 'event-types', 'schedules', 'users/me'}


class TestCalendarValidation:
    def test_valid_uids_accepted(self):
        valid = ["abc123", "A1B2-C3", "booking_uid_xyz", "x" * 64]
        for uid in valid:
            assert UID_PATTERN.match(uid), f"Should be valid: {uid}"

    def test_invalid_uids_rejected(self):
        invalid = [
            "",
            "../../etc/passwd",
            "uid with spaces",
            "uid/with/slash",
            "uid?query=1",
            "x" * 65,          # too long
            "uid\nnewline",
            "uid;ls",
        ]
        for uid in invalid:
            assert not UID_PATTERN.match(uid), f"Should be invalid: {uid!r}"

    def test_allowed_endpoints_are_safe(self):
        for ep in ALLOWED_ENDPOINTS:
            # None should contain path traversal or special chars
            assert ".." not in ep
            assert ";" not in ep

    def test_unknown_endpoints_blocked(self):
        assert "admin/delete" not in ALLOWED_ENDPOINTS
        assert "../../etc" not in ALLOWED_ENDPOINTS
        assert "" not in ALLOWED_ENDPOINTS
        assert "bookings?apiKey=evil" not in ALLOWED_ENDPOINTS

    def test_cal_limit_bounded(self):
        # Simulates: limit = int(sys.argv[1]) if sys.argv[1].isdigit() else 5
        def parse_limit(arg):
            if arg.isdigit():
                return min(int(arg), 20)
            return 5
        assert parse_limit("10") == 10
        assert parse_limit("25") == 20   # capped at 20
        assert parse_limit("abc") == 5   # default
        assert parse_limit("") == 5      # default


# ---------------------------------------------------------------------------
# bodhi-accountability: commitment tracking + streak logic
# ---------------------------------------------------------------------------

def make_commitment(text: str, freq: str = "daily", domain: str = "wellness") -> dict:
    days_ahead = 1 if freq == "daily" else 7
    return {
        "id": str(uuid.uuid4())[:8],
        "text": text[:300],
        "type": "habit",
        "frequency": freq,
        "status": "active",
        "streak": 0,
        "best_streak": 0,
        "created_at": datetime.now().isoformat(),
        "last_checked": None,
        "next_check": (date.today() + timedelta(days=days_ahead)).isoformat(),
        "check_history": [],
        "domain": domain
    }


def check_commitment(commitment: dict, today_str: str) -> dict:
    """Simulate /commit check logic."""
    yesterday = (date.fromisoformat(today_str) - timedelta(days=1)).isoformat()
    last = commitment.get("last_checked")

    if last == today_str:
        raise ValueError("ALREADY_CHECKED")

    if last is None or last == yesterday:
        commitment["streak"] += 1
    else:
        # Gap — reset streak
        commitment["streak"] = 1

    commitment["best_streak"] = max(
        commitment.get("best_streak", 0),
        commitment["streak"]
    )
    commitment["last_checked"] = today_str
    freq = commitment.get("frequency", "daily")
    days_ahead = 1 if freq == "daily" else 7
    commitment["next_check"] = (
        date.fromisoformat(today_str) + timedelta(days=days_ahead)
    ).isoformat()
    commitment["check_history"].append({"date": today_str, "kept": True})
    return commitment


def miss_commitment(commitment: dict, today_str: str) -> dict:
    """Simulate /commit miss logic."""
    commitment["streak"] = 0
    commitment["check_history"].append({"date": today_str, "kept": False})
    freq = commitment.get("frequency", "daily")
    days_ahead = 1 if freq == "daily" else 7
    commitment["next_check"] = (
        date.fromisoformat(today_str) + timedelta(days=days_ahead)
    ).isoformat()
    return commitment


class TestAccountabilityStreaks:
    def test_first_check_sets_streak_1(self):
        c = make_commitment("walk 30 minutes")
        c = check_commitment(c, "2026-03-15")
        assert c["streak"] == 1

    def test_consecutive_days_increment(self):
        c = make_commitment("walk 30 minutes")
        c = check_commitment(c, "2026-03-14")
        c = check_commitment(c, "2026-03-15")
        assert c["streak"] == 2

    def test_missed_day_resets_streak(self):
        c = make_commitment("walk 30 minutes")
        c = check_commitment(c, "2026-03-13")
        c = check_commitment(c, "2026-03-15")  # skipped 14
        assert c["streak"] == 1

    def test_miss_command_resets_streak(self):
        c = make_commitment("meditate")
        c = check_commitment(c, "2026-03-14")
        assert c["streak"] == 1
        c = miss_commitment(c, "2026-03-15")
        assert c["streak"] == 0

    def test_best_streak_preserved_after_reset(self):
        c = make_commitment("workout")
        for day in ["2026-03-10", "2026-03-11", "2026-03-12"]:
            c = check_commitment(c, day)
        assert c["best_streak"] == 3
        c = miss_commitment(c, "2026-03-13")
        assert c["streak"] == 0
        assert c["best_streak"] == 3  # preserved

    def test_double_check_same_day_raises(self):
        c = make_commitment("read")
        c = check_commitment(c, "2026-03-15")
        with pytest.raises(ValueError, match="ALREADY_CHECKED"):
            check_commitment(c, "2026-03-15")

    def test_weekly_commitment_next_check_7_days(self):
        c = make_commitment("long run", freq="weekly")
        c = check_commitment(c, "2026-03-15")
        expected = (date.fromisoformat("2026-03-15") + timedelta(days=7)).isoformat()
        assert c["next_check"] == expected

    def test_check_history_appended(self):
        c = make_commitment("stretch")
        c = check_commitment(c, "2026-03-14")
        c = check_commitment(c, "2026-03-15")
        assert len(c["check_history"]) == 2
        assert c["check_history"][0]["kept"] is True
        assert c["check_history"][1]["kept"] is True

    def test_miss_appends_false_to_history(self):
        c = make_commitment("cold shower")
        c = miss_commitment(c, "2026-03-15")
        assert c["check_history"][0]["kept"] is False

    def test_check_history_capped_at_90(self):
        c = make_commitment("habit")
        # Pre-fill with 90 entries
        c["check_history"] = [{"date": f"2025-{i:04d}", "kept": True} for i in range(90)]
        c["check_history"].append({"date": "2026-03-15", "kept": True})
        # Cap logic
        if len(c["check_history"]) > 90:
            c["check_history"] = c["check_history"][-90:]
        assert len(c["check_history"]) == 90
        # Most recent preserved
        assert c["check_history"][-1]["date"] == "2026-03-15"

    def test_domain_inference_fitness(self):
        keywords = {"walk", "run", "gym", "workout", "exercise", "training",
                    "lift", "swim", "bike", "yoga"}
        text = "30 minutes of running every morning"
        lower = text.lower()
        domain = "wellness"
        if any(w in lower for w in keywords):
            domain = "fitness"
        assert domain == "fitness"

    def test_domain_inference_cognitive(self):
        keywords = {"read", "study", "learn", "practice", "skill", "write", "code", "book"}
        text = "read 20 pages every evening"
        lower = text.lower()
        domain = "wellness"
        if any(w in lower for w in keywords):
            domain = "cognitive"
        assert domain == "cognitive"

    def test_domain_inference_defaults_to_wellness(self):
        text = "be more present today"
        fitness = {"walk", "run", "gym", "workout"}
        health = {"eat", "nutrition", "sleep"}
        cognitive = {"read", "study", "learn"}
        mental = {"meditate", "journal", "therapy"}
        lower = text.lower()
        domain = "wellness"
        if any(w in lower for w in fitness): domain = "fitness"
        elif any(w in lower for w in health): domain = "health"
        elif any(w in lower for w in cognitive): domain = "cognitive"
        elif any(w in lower for w in mental): domain = "mental-health"
        assert domain == "wellness"

    def test_commitment_text_truncated_at_300(self):
        c = make_commitment("x" * 400)
        assert len(c["text"]) == 300

    def test_paused_commitment_not_in_due_list(self):
        today = "2026-03-15"
        commitments = [
            {**make_commitment("daily walk"), "next_check": today, "status": "active"},
            {**make_commitment("weekly run"), "next_check": today, "status": "paused"},
        ]
        due = [c for c in commitments
               if c.get("status") == "active" and c.get("next_check") == today]
        assert len(due) == 1
        assert due[0]["text"] == "daily walk"

    def test_state_persisted_atomically(self, tmp_path):
        p = tmp_path / "accountability.json"
        c = make_commitment("read 20 pages")
        data = {"commitments": [c]}
        atomic_write(p, data)
        loaded = read_json(p)
        assert len(loaded["commitments"]) == 1
        assert loaded["commitments"][0]["status"] == "active"


# ---------------------------------------------------------------------------
# Integration: checkin reads accountability due items
# ---------------------------------------------------------------------------

class TestCheckinAccountabilityIntegration:
    def test_evening_surfaces_due_commitments(self, tmp_path):
        today = "2026-03-15"
        commitments = [
            {**make_commitment("walk"), "next_check": today, "status": "active"},
            {**make_commitment("stretch"), "next_check": "2026-03-16", "status": "active"},
            {**make_commitment("run"), "next_check": today, "status": "paused"},
        ]
        data = {"commitments": commitments}
        p = tmp_path / "accountability.json"
        atomic_write(p, data)

        loaded = read_json(p)
        due = [c for c in loaded.get("commitments", [])
               if c.get("status") == "active" and c.get("next_check") == today]

        # Only one active+due (paused excluded, future excluded)
        assert len(due) == 1
        assert due[0]["text"] == "walk"

    def test_checkin_vault_node_structure(self):
        import hashlib
        energy = 4
        intention = "stay focused on the proposal"
        content = f"Morning check-in. Energy: {energy}. Intention: {intention}"
        node = {
            "id": str(uuid.uuid4()),
            "content": content,
            "domain": "wellness",
            "energy": energy,
            "tags": ["check-in", "morning", "intention"],
            "media_type": "text",
            "created_at": datetime.now().isoformat(),
            "sha256": hashlib.sha256(content.encode()).hexdigest()
        }
        assert node["domain"] == "wellness"
        assert node["energy"] == 4
        assert "check-in" in node["tags"]
        assert len(node["sha256"]) == 64

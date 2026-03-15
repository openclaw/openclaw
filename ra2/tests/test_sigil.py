"""Tests for ra2.sigil (JSON layered format)"""

import json
import pytest
from ra2 import sigil


@pytest.fixture(autouse=True)
def tmp_sigil_dir(monkeypatch, tmp_path):
    """Redirect sigil storage to a temp directory for each test."""
    d = str(tmp_path / "sigils")
    monkeypatch.setattr(sigil, "SIGIL_DIR", d)
    return d


# ── Load / Save ─────────────────────────────────────────────────────

class TestLoadSave:
    def test_load_empty(self):
        state = sigil.load("test-stream")
        assert state["event"] == []
        assert state["state"]["arch"]["wrapper"] == ""
        assert state["state"]["risk"]["token_pressure"] == ""
        assert state["state"]["mode"]["debug"] is False

    def test_save_and_load_roundtrip(self):
        state = sigil._empty_state()
        state["event"].append({
            "operator": "fork",
            "constraint": "architectural_scope",
            "decision": "thin_wrapper",
            "timestamp": "2026-02-19T04:00:00Z",
        })
        state["state"]["arch"]["wrapper"] = "thin"
        sigil.save("s1", state)
        loaded = sigil.load("s1")
        assert len(loaded["event"]) == 1
        assert loaded["event"][0]["operator"] == "fork"
        assert loaded["state"]["arch"]["wrapper"] == "thin"

    def test_save_creates_json_file(self, tmp_sigil_dir):
        state = sigil._empty_state()
        sigil.save("s1", state)
        import os
        path = os.path.join(tmp_sigil_dir, "s1.json")
        assert os.path.exists(path)
        with open(path) as f:
            data = json.load(f)
        assert "event" in data
        assert "state" in data

    def test_fifo_on_save(self):
        state = sigil._empty_state()
        for i in range(20):
            state["event"].append({
                "operator": f"op_{i}",
                "constraint": "c",
                "decision": "d",
                "timestamp": "2026-01-01T00:00:00Z",
            })
        sigil.save("s1", state)
        loaded = sigil.load("s1")
        assert len(loaded["event"]) == sigil.MAX_EVENT_ENTRIES
        # Should keep the last 15
        assert loaded["event"][0]["operator"] == "op_5"
        assert loaded["event"][-1]["operator"] == "op_19"

    def test_corrupt_file_returns_empty(self, tmp_sigil_dir):
        import os
        os.makedirs(tmp_sigil_dir, exist_ok=True)
        path = os.path.join(tmp_sigil_dir, "bad.json")
        with open(path, "w") as f:
            f.write("not valid json{{{")
        state = sigil.load("bad")
        assert state["event"] == []
        assert "arch" in state["state"]

    def test_missing_sections_filled(self, tmp_sigil_dir):
        import os
        os.makedirs(tmp_sigil_dir, exist_ok=True)
        path = os.path.join(tmp_sigil_dir, "partial.json")
        with open(path, "w") as f:
            json.dump({"event": [], "state": {}}, f)
        state = sigil.load("partial")
        assert "arch" in state["state"]
        assert "risk" in state["state"]
        assert "mode" in state["state"]


# ── append_event ────────────────────────────────────────────────────

class TestAppendEvent:
    def test_append_single(self):
        state = sigil.append_event("s1", "fork", "arch_scope", "thin_wrapper")
        assert len(state["event"]) == 1
        assert state["event"][0]["operator"] == "fork"
        assert state["event"][0]["constraint"] == "arch_scope"
        assert state["event"][0]["decision"] == "thin_wrapper"
        assert "timestamp" in state["event"][0]

    def test_append_multiple(self):
        sigil.append_event("s1", "fork", "scope", "wrapper")
        state = sigil.append_event("s1", "token_burn", "overflow", "compress")
        assert len(state["event"]) == 2

    def test_deduplication(self):
        sigil.append_event("s1", "fork", "scope", "wrapper")
        state = sigil.append_event("s1", "fork", "scope", "wrapper")
        assert len(state["event"]) == 1

    def test_fifo_eviction(self):
        for i in range(20):
            state = sigil.append_event("s1", f"op_{i}", "c", "d")
        assert len(state["event"]) == sigil.MAX_EVENT_ENTRIES
        operators = [e["operator"] for e in state["event"]]
        assert "op_0" not in operators
        assert "op_19" in operators

    def test_rejects_empty_fields(self):
        state = sigil.append_event("s1", "", "c", "d")
        assert len(state["event"]) == 0

    def test_truncates_long_fields(self):
        long_val = "a" * 100
        state = sigil.append_event("s1", long_val, "c", "d")
        assert len(state["event"]) == 1
        assert len(state["event"][0]["operator"]) <= sigil.MAX_FIELD_CHARS


# ── update_state ────────────────────────────────────────────────────

class TestUpdateState:
    def test_update_arch(self):
        state = sigil.update_state("s1", arch={
            "wrapper": "thin",
            "compression": "rule_based_v1",
            "agents": "disabled",
            "router": "legacy",
        })
        assert state["state"]["arch"]["wrapper"] == "thin"
        assert state["state"]["arch"]["compression"] == "rule_based_v1"

    def test_update_risk(self):
        state = sigil.update_state("s1", risk={
            "token_pressure": "controlled",
            "cooldown": "monitored",
            "scope_creep": "constrained",
        })
        assert state["state"]["risk"]["token_pressure"] == "controlled"

    def test_update_mode(self):
        state = sigil.update_state("s1", mode={
            "determinism": "prioritized",
            "rewrite_mode": "disabled",
            "debug": False,
        })
        assert state["state"]["mode"]["determinism"] == "prioritized"

    def test_update_overwrites(self):
        sigil.update_state("s1", arch={"wrapper": "thin"})
        state = sigil.update_state("s1", arch={"wrapper": "fat"})
        assert state["state"]["arch"]["wrapper"] == "fat"

    def test_update_preserves_events(self):
        sigil.append_event("s1", "fork", "scope", "wrapper")
        state = sigil.update_state("s1", arch={"wrapper": "thin"})
        assert len(state["event"]) == 1
        assert state["state"]["arch"]["wrapper"] == "thin"

    def test_partial_update(self):
        sigil.update_state("s1", arch={"wrapper": "thin"})
        state = sigil.update_state("s1", risk={"token_pressure": "high"})
        # arch should still be there
        assert state["state"]["arch"]["wrapper"] == "thin"
        assert state["state"]["risk"]["token_pressure"] == "high"


# ── snapshot ────────────────────────────────────────────────────────

class TestSnapshot:
    def test_snapshot_empty(self):
        snap = sigil.snapshot("empty")
        assert snap == "(no sigils)"

    def test_snapshot_with_events(self):
        sigil.append_event("s1", "fork", "scope", "wrapper")
        snap = sigil.snapshot("s1")
        data = json.loads(snap)
        assert len(data["event"]) == 1
        assert data["event"][0]["operator"] == "fork"

    def test_snapshot_with_state(self):
        sigil.update_state("s1", arch={"wrapper": "thin"})
        snap = sigil.snapshot("s1")
        data = json.loads(snap)
        assert data["state"]["arch"]["wrapper"] == "thin"

    def test_snapshot_is_valid_json(self):
        sigil.append_event("s1", "fork", "scope", "wrapper")
        sigil.update_state("s1", arch={"wrapper": "thin"})
        snap = sigil.snapshot("s1")
        data = json.loads(snap)  # Should not raise
        assert "event" in data
        assert "state" in data


# ── generate_from_message ───────────────────────────────────────────

class TestGenerateFromMessage:
    def test_fork_detection(self):
        result = sigil.generate_from_message("We forked to context_sov branch")
        assert result is not None
        op, constraint, decision = result
        assert op == "fork"
        assert constraint == "architectural_scope"
        assert "context_sov" in decision

    def test_token_burn_detection(self):
        result = sigil.generate_from_message("Seeing token burn on this stream")
        assert result == ("token_burn", "context_overflow", "compress_first")

    def test_rate_limit_detection(self):
        result = sigil.generate_from_message("Hit a rate limit again")
        assert result == ("rate_limit", "cooldown_active", "fallback_model")

    def test_thin_wrapper_detection(self):
        result = sigil.generate_from_message("Use a thin wrapper approach")
        assert result is not None
        assert result[2] == "thin_wrapper"

    def test_no_match(self):
        result = sigil.generate_from_message("Hello, how are you?")
        assert result is None

    def test_returns_triple(self):
        result = sigil.generate_from_message("compaction trigger needed")
        assert result is not None
        assert len(result) == 3
        op, constraint, decision = result
        assert op == "compaction"
        assert constraint == "history_overflow"
        assert decision == "compact_now"


# ── File size cap ───────────────────────────────────────────────────

class TestFileSizeCap:
    def test_file_respects_size_cap(self, monkeypatch, tmp_sigil_dir):
        import os
        # Set a small cap
        monkeypatch.setattr(sigil, "MAX_FILE_BYTES", 512)
        for i in range(20):
            sigil.append_event("s1", f"operator_{i}", "constraint", "decision")
        path = os.path.join(tmp_sigil_dir, "s1.json")
        size = os.path.getsize(path)
        assert size <= 512

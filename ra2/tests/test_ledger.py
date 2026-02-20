"""Tests for ra2.ledger"""

import json
import os
import tempfile
import pytest
from ra2 import ledger


@pytest.fixture(autouse=True)
def tmp_ledger_dir(monkeypatch, tmp_path):
    """Redirect ledger storage to a temp directory for each test."""
    d = str(tmp_path / "ledgers")
    monkeypatch.setattr(ledger, "LEDGER_DIR", d)
    return d


class TestLoadSave:
    def test_load_empty(self):
        data = ledger.load("test-stream")
        assert data["stream"] == "test-stream"
        assert data["orientation"] == ""
        assert data["blockers"] == []
        assert data["open"] == []

    def test_save_and_load(self):
        data = {
            "stream": "s1",
            "orientation": "build context engine",
            "latest": "implemented ledger",
            "blockers": ["rate limits"],
            "open": ["how to compress?"],
            "delta": "added ledger module",
        }
        ledger.save("s1", data)
        loaded = ledger.load("s1")
        assert loaded == data

    def test_save_enforces_field_length(self):
        data = {
            "stream": "s1",
            "orientation": "x" * 1000,
            "latest": "",
            "blockers": [],
            "open": [],
            "delta": "",
        }
        ledger.save("s1", data)
        loaded = ledger.load("s1")
        assert len(loaded["orientation"]) == ledger.MAX_FIELD_CHARS

    def test_save_enforces_list_length(self):
        data = {
            "stream": "s1",
            "orientation": "",
            "latest": "",
            "blockers": [f"blocker-{i}" for i in range(20)],
            "open": [f"question-{i}" for i in range(20)],
            "delta": "",
        }
        ledger.save("s1", data)
        loaded = ledger.load("s1")
        assert len(loaded["blockers"]) == ledger.MAX_BLOCKERS
        assert len(loaded["open"]) == ledger.MAX_OPEN


class TestUpdate:
    def test_update_fields(self):
        result = ledger.update("s1", orientation="test orientation", delta="did stuff")
        assert result["orientation"] == "test orientation"
        assert result["delta"] == "did stuff"
        assert result["stream"] == "s1"

    def test_update_ignores_unknown_keys(self):
        result = ledger.update("s1", unknown_key="value")
        assert "unknown_key" not in result

    def test_update_persists(self):
        ledger.update("s1", orientation="phase 1")
        loaded = ledger.load("s1")
        assert loaded["orientation"] == "phase 1"


class TestSnapshot:
    def test_snapshot_empty(self):
        snap = ledger.snapshot("empty-stream")
        assert "stream: empty-stream" in snap
        assert "orientation:" in snap

    def test_snapshot_with_data(self):
        ledger.update(
            "s1",
            orientation="context sovereignty",
            blockers=["rate limits"],
            open=["compression strategy?"],
        )
        snap = ledger.snapshot("s1")
        assert "context sovereignty" in snap
        assert "rate limits" in snap
        assert "compression strategy?" in snap

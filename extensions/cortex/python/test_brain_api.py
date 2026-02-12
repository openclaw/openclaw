#!/usr/bin/env python3
"""
test_brain_api.py — Integration tests for brain_api.py (FastAPI on port 8031)

Tests the REST API against a live server. Requires brain-api service running.

Usage:
    pytest test_brain_api.py -v
    # or: pytest test_brain_api.py -v -k "not slow"
"""
import time
import uuid

import pytest
import requests

BASE = "http://localhost:8031"
TIMEOUT = 5


def _api(method, path, **kwargs):
    """Helper: make API call with timeout."""
    kwargs.setdefault("timeout", TIMEOUT)
    return getattr(requests, method)(f"{BASE}{path}", **kwargs)


def _unique(prefix="apitest"):
    return f"{prefix}_{uuid.uuid4().hex[:8]}"


# ============================================================
# Fixtures
# ============================================================

@pytest.fixture(scope="session", autouse=True)
def check_api_running():
    """Skip all tests if API is not reachable."""
    try:
        r = requests.get(f"{BASE}/health", timeout=3)
        if r.status_code != 200:
            pytest.skip("Brain API not healthy")
    except requests.ConnectionError:
        pytest.skip("Brain API not running on port 8031")


# ============================================================
# Health & Stats
# ============================================================

class TestHealth:
    def test_health_200(self):
        r = _api("get", "/health")
        assert r.status_code == 200
        data = r.json()
        assert data["status"] == "ok"
        assert "stm_entries" in data
        assert "messages" in data
        assert "atoms" in data

    def test_stats_200(self):
        r = _api("get", "/stats")
        assert r.status_code == 200
        data = r.json()
        for key in ["messages", "stm_entries", "atoms", "embeddings", "db_path"]:
            assert key in data, f"Missing key: {key}"


# ============================================================
# Remember + STM
# ============================================================

class TestRemember:
    def test_post_remember(self):
        tag = _unique("remember")
        r = _api("post", "/remember", json={
            "content": f"API test entry {tag}",
            "importance": 1.5,
            "categories": ["api_test"],
        })
        assert r.status_code == 200
        data = r.json()
        assert data["stored"] is True
        assert data["id"].startswith("stm_")

    def test_remember_then_stm(self):
        tag = _unique("stm_verify")
        # Store
        r = _api("post", "/remember", json={
            "content": f"Verify via STM {tag}",
            "importance": 2.0,
            "categories": ["api_test"],
        })
        assert r.status_code == 200
        mem_id = r.json()["id"]

        # Retrieve via STM (should be in recent)
        r2 = _api("get", "/stm", params={"limit": 20, "category": "api_test"})
        assert r2.status_code == 200
        entries = r2.json()["entries"]
        ids = [e["id"] for e in entries]
        assert mem_id in ids, f"Stored entry {mem_id} not in STM response"

    def test_remember_empty_content_400(self):
        r = _api("post", "/remember", json={"content": "   "})
        assert r.status_code == 400

    def test_remember_missing_content_422(self):
        r = _api("post", "/remember", json={"importance": 1.0})
        assert r.status_code == 422

    def test_stm_limit(self):
        r = _api("get", "/stm", params={"limit": 3})
        assert r.status_code == 200
        assert len(r.json()["entries"]) <= 3


# ============================================================
# Search
# ============================================================

class TestSearch:
    def test_post_search_fts(self):
        # Seed data
        tag = _unique("search")
        _api("post", "/remember", json={
            "content": f"Searchable content {tag} for FTS verification",
            "categories": ["api_test"],
        })

        # Search
        r = _api("post", "/search", json={
            "query": tag,
            "search_type": "fts",
            "limit": 10,
        })
        assert r.status_code == 200
        data = r.json()
        assert data["query"] == tag
        assert data["count"] >= 1
        assert any(tag in str(res.get("content", "")) for res in data["results"])

    def test_search_empty_query_400(self):
        r = _api("post", "/search", json={"query": "  "})
        assert r.status_code == 400

    def test_search_missing_query_422(self):
        r = _api("post", "/search", json={"limit": 5})
        assert r.status_code == 422

    def test_search_types(self):
        """Search should accept all search_type values."""
        for st in ["fts", "semantic", "fts+semantic"]:
            r = _api("post", "/search", json={"query": "test", "search_type": st})
            assert r.status_code == 200, f"Failed for search_type={st}"


# ============================================================
# SYNAPSE: Send + Inbox
# ============================================================

class TestSynapse:
    def test_post_send(self):
        tag = _unique("send")
        r = _api("post", "/send", json={
            "from_agent": "api_test",
            "to_agent": "api_inbox",
            "content": f"SYNAPSE test {tag}",
            "subject": f"Test {tag}",
            "priority": "info",
        })
        assert r.status_code == 200
        data = r.json()
        assert data["id"].startswith("syn_")
        assert data["from"] == "api_test"

    def test_send_then_inbox(self):
        tag = _unique("inbox")
        target = _unique("agent")

        # Send
        r = _api("post", "/send", json={
            "from_agent": "api_sender",
            "to_agent": target,
            "content": f"Inbox verify {tag}",
            "subject": f"Inbox {tag}",
        })
        assert r.status_code == 200
        msg_id = r.json()["id"]

        # Check inbox
        r2 = _api("get", f"/inbox/{target}")
        assert r2.status_code == 200
        data = r2.json()
        assert data["agent"] == target
        ids = [m["id"] for m in data["messages"]]
        assert msg_id in ids, f"Sent message {msg_id} not in inbox"

    def test_send_empty_content_400(self):
        r = _api("post", "/send", json={
            "from_agent": "a",
            "to_agent": "b",
            "content": "  ",
        })
        assert r.status_code == 400

    def test_send_missing_fields_422(self):
        r = _api("post", "/send", json={"from_agent": "a"})
        assert r.status_code == 422

    def test_inbox_empty_agent(self):
        r = _api("get", f"/inbox/{_unique('nobody')}")
        assert r.status_code == 200
        assert r.json()["count"] == 0


# ============================================================
# Atoms
# ============================================================

class TestAtom:
    def test_post_atom(self):
        r = _api("post", "/atom", json={
            "subject": "api_test_entity",
            "action": "creates atom via API",
            "outcome": "atom stored",
            "consequences": "verifiable via stats",
            "confidence": 0.9,
        })
        assert r.status_code == 200
        data = r.json()
        assert data["created"] is True
        assert data["id"].startswith("atm_")

    def test_atom_increases_count(self):
        # Get baseline
        r1 = _api("get", "/stats")
        before = r1.json()["atoms"]

        # Create atom
        _api("post", "/atom", json={
            "subject": "count_test",
            "action": "increments",
            "outcome": "count goes up",
            "consequences": "verified by stats",
        })

        # Check increase
        r2 = _api("get", "/stats")
        after = r2.json()["atoms"]
        assert after > before, f"Atom count didn't increase: {before} → {after}"

    def test_atom_missing_fields_422(self):
        r = _api("post", "/atom", json={"subject": "only_subject"})
        assert r.status_code == 422

    def test_atom_empty_field_400(self):
        r = _api("post", "/atom", json={
            "subject": "  ",
            "action": "test",
            "outcome": "test",
            "consequences": "test",
        })
        assert r.status_code == 400


# ============================================================
# Embed endpoint
# ============================================================

class TestEmbed:
    def test_post_embed(self):
        r = _api("post", "/embed", params={"batch_size": 5})
        assert r.status_code == 200
        data = r.json()
        assert "processed" in data
        assert "batch_size" in data


# ============================================================
# STM (GET variants)
# ============================================================

class TestSTMGet:
    def test_stm_default(self):
        r = _api("get", "/stm")
        assert r.status_code == 200
        assert "entries" in r.json()

    def test_stm_with_category(self):
        # Seed
        _api("post", "/remember", json={
            "content": "Category filter test",
            "categories": ["api_filter_test"],
        })
        r = _api("get", "/stm", params={"category": "api_filter_test", "limit": 10})
        assert r.status_code == 200
        # Should contain at least our seeded entry
        entries = r.json()["entries"]
        assert len(entries) >= 1

    def test_stm_limit_bounds(self):
        # limit < 1 should fail
        r = _api("get", "/stm", params={"limit": 0})
        assert r.status_code == 422

        # limit > 100 should fail
        r = _api("get", "/stm", params={"limit": 101})
        assert r.status_code == 422

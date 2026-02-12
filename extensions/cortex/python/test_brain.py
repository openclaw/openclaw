"""
Comprehensive test suite for brain.py (UnifiedBrain).
Tests: STM, messages, atoms, provenance, FTS5, semantic search.

Usage:
    CORTEX_DATA_DIR=/tmp/brain_test pytest test_brain.py -v
"""
import json
import os
import sqlite3
import tempfile
import time
from pathlib import Path

import pytest

# Force test data dir
TEST_DIR = tempfile.mkdtemp(prefix="brain_test_")
os.environ["CORTEX_DATA_DIR"] = TEST_DIR

from brain import UnifiedBrain, _gen_id, _now


# ============================================================
# Fixtures
# ============================================================

@pytest.fixture
def brain(tmp_path):
    """Fresh brain per test class for isolation."""
    return UnifiedBrain(str(tmp_path / "test.db"))


def _has_gpu_daemon():
    try:
        import requests
        return requests.get("http://localhost:8030/health", timeout=2).status_code == 200
    except Exception:
        return False


SKIP_NO_GPU = pytest.mark.skipif(not _has_gpu_daemon(), reason="Embeddings daemon not running")


# ============================================================
# Schema & Init
# ============================================================

class TestInit:
    def test_creates_db_file(self, brain):
        assert Path(brain.db_path).exists()

    def test_wal_mode(self, brain):
        conn = sqlite3.connect(str(brain.db_path))
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
        conn.close()
        assert mode == "wal"

    def test_tables_exist(self, brain):
        conn = sqlite3.connect(str(brain.db_path))
        tables = [r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()]
        conn.close()
        for t in ["messages", "threads", "stm", "atoms", "causal_links",
                   "embeddings", "acks", "stm_fts", "messages_fts", "atoms_fts"]:
            assert t in tables, f"Missing table: {t}"

    def test_stats_empty(self, brain):
        s = brain.stats()
        assert s["messages"] == 0
        assert s["stm_entries"] == 0
        assert s["atoms"] == 0


# ============================================================
# STM
# ============================================================

class TestSTM:
    def test_remember_returns_id(self, brain):
        assert brain.remember("Test", categories=["test"]).startswith("stm_")

    def test_remember_content(self, brain):
        content = f"Unique {time.time()}"
        brain.remember(content, categories=["test"])
        stm = brain.get_stm(limit=1)
        assert stm[0]["content"] == content

    def test_get_stm_limit(self, brain):
        for i in range(5):
            brain.remember(f"Item {i}", categories=["test"])
        assert len(brain.get_stm(limit=3)) == 3

    def test_get_stm_by_category(self, brain):
        brain.remember("Cat A", categories=["alpha"])
        brain.remember("Cat B", categories=["beta"])
        results = brain.get_stm(limit=100, category="alpha")
        assert len(results) >= 1
        for r in results:
            cats = json.loads(r["categories"]) if isinstance(r["categories"], str) else r["categories"]
            assert "alpha" in cats

    def test_importance(self, brain):
        mid = brain.remember("Important", importance=3.0, categories=["test"])
        stm = brain.get_stm(limit=50)
        found = [s for s in stm if s["id"] == mid]
        assert found[0]["importance"] == 3.0

    def test_update_stm(self, brain):
        mid = brain.remember("Update me", categories=["test"])
        assert brain.update_stm(mid, importance=2.5) is True

    def test_provenance_field(self, brain):
        # Create a real message first (FK constraint)
        msg = brain.send("alice", "bob", "Source", "Body")
        mid = brain.remember("Prov test", categories=["test"], source_message_id=msg["id"])
        conn = sqlite3.connect(str(brain.db_path))
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT source_message_id FROM stm WHERE id = ?", (mid,)).fetchone()
        conn.close()
        assert row["source_message_id"] == msg["id"]


# ============================================================
# Messages (SYNAPSE)
# ============================================================

class TestMessages:
    def test_send_returns_dict(self, brain):
        r = brain.send("alice", "bob", "Test", "Hello")
        assert r["id"].startswith("syn_")
        assert r["from"] == "alice"
        assert r["to"] == "bob"

    def test_send_creates_thread(self, brain):
        r = brain.send("alice", "bob", "Thread", "Body")
        assert r["thread_id"].startswith("thr_")

    def test_inbox_unread(self, brain):
        brain.send("alice", "carol", "Inbox", "Msg")
        inbox = brain.inbox("carol")
        assert any(m["subject"] == "Inbox" for m in inbox)

    def test_read_marks_as_read(self, brain):
        r = brain.send("alice", "dave", "Read", "Body")
        brain.read_message(r["id"], "dave")
        inbox = brain.inbox("dave", include_read=False)
        assert r["id"] not in [m["id"] for m in inbox]

    def test_history(self, brain):
        tid = None
        for i in range(3):
            r = brain.send("alice", "bob", f"H{i}", f"M{i}", thread_id=tid)
            tid = r["thread_id"]
        assert len(brain.history(thread_id=tid)) >= 3

    def test_list_threads(self, brain):
        brain.send("alice", "bob", "Thread", "Body")
        assert len(brain.list_threads()) > 0

    def test_auto_extract_remember(self, brain):
        r = brain.send("alice", "bob", "Tag", "@remember Extract this content")
        conn = sqlite3.connect(str(brain.db_path))
        row = conn.execute(
            "SELECT COUNT(*) FROM stm WHERE source_message_id = ?", (r["id"],)
        ).fetchone()
        conn.close()
        assert row[0] >= 1

    def test_auto_extract_insight(self, brain):
        r = brain.send("alice", "bob", "Tag", "Context. @insight Key finding here.")
        conn = sqlite3.connect(str(brain.db_path))
        row = conn.execute(
            "SELECT COUNT(*) FROM stm WHERE source_message_id = ?", (r["id"],)
        ).fetchone()
        conn.close()
        assert row[0] >= 1


# ============================================================
# Atoms
# ============================================================

class TestAtoms:
    def test_create_returns_id(self, brain):
        assert brain.create_atom("subj", "act", "out", "cons").startswith("atm_")

    def test_create_with_provenance(self, brain):
        msg = brain.send("alice", "bob", "Src", "Source msg")
        aid = brain.create_atom("s", "a", "o", "c", source_message_id=msg["id"])
        chain = brain.find_provenance(aid)
        assert chain is not None
        assert len(chain) >= 1
        # First link should be the atom
        assert chain[0]["type"] == "atom"
        # Chain should include the source message
        assert any(c["type"] == "message" for c in chain)

    def test_link_atoms(self, brain):
        a1 = brain.create_atom("cause", "happens", "effect", "chain")
        a2 = brain.create_atom("effect", "triggers", "result", "cascade")
        lid = brain.link_atoms(a1, a2, "causes", strength=0.8)
        assert lid is not None


# ============================================================
# FTS5
# ============================================================

class TestFTS5:
    def test_search_stm(self, brain):
        unique = f"xenomorphic{int(time.time())}"
        brain.remember(f"The {unique} pattern", categories=["test"])
        results = brain.unified_search(unique, types=["stm"])
        assert any(unique in str(r.get("content", "")) for r in results)

    def test_search_messages(self, brain):
        unique = f"quasimodo{int(time.time())}"
        brain.send("alice", "bob", f"About {unique}", f"The {unique} thing")
        results = brain.unified_search(unique, types=["message"])
        assert len(results) > 0

    def test_search_atoms(self, brain):
        unique = f"zygomorphic{int(time.time())}"
        brain.create_atom(unique, "exhibits", "pattern", "consequence")
        results = brain.unified_search(unique, types=["atom"])
        assert len(results) > 0

    def test_unified_search_all(self, brain):
        unique = f"omnisearch{int(time.time())}"
        brain.remember(f"STM {unique}", categories=["test"])
        brain.send("alice", "bob", f"Msg {unique}", f"Body {unique}")
        brain.create_atom(unique, "tested", "found", "validated")
        results = brain.unified_search(unique)
        assert len(results) >= 2


# ============================================================
# Provenance
# ============================================================

class TestProvenance:
    def test_stm_chain(self, brain):
        """Message → auto-extract → STM with provenance chain."""
        msg = brain.send("alice", "bob", "Prov", "@remember Chain test data")
        conn = sqlite3.connect(str(brain.db_path))
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            "SELECT id FROM stm WHERE source_message_id = ?", (msg["id"],)
        ).fetchone()
        conn.close()
        assert row is not None
        chain = brain.find_provenance(row["id"])
        assert chain is not None
        types = [c["type"] for c in chain]
        assert "stm" in types
        assert "message" in types

    def test_atom_chain(self, brain):
        msg = brain.send("alice", "bob", "Atom Src", "For atom")
        aid = brain.create_atom("t", "a", "o", "c", source_message_id=msg["id"])
        chain = brain.find_provenance(aid)
        assert chain is not None
        assert chain[0]["type"] == "atom"
        assert chain[-1]["type"] == "message"

    def test_no_provenance(self, brain):
        mid = brain.remember("Orphan", categories=["test"])
        chain = brain.find_provenance(mid)
        # Should return a chain with just the STM entry (no source_message)
        assert chain is not None
        assert len(chain) == 1
        assert chain[0]["type"] == "stm"
        assert chain[0]["source_id"] is None


# ============================================================
# Embeddings (GPU)
# ============================================================

@SKIP_NO_GPU
class TestEmbeddings:
    def test_auto_embed_remember(self, brain):
        mid = brain.remember(f"Embed test {time.time()}", categories=["test"])
        conn = sqlite3.connect(str(brain.db_path))
        row = conn.execute(
            "SELECT COUNT(*) FROM embeddings WHERE source_type='stm' AND source_id=?", (mid,)
        ).fetchone()
        conn.close()
        assert row[0] == 1

    def test_auto_embed_send(self, brain):
        r = brain.send("a", "b", "Embed", f"Content {time.time()}")
        conn = sqlite3.connect(str(brain.db_path))
        row = conn.execute(
            "SELECT COUNT(*) FROM embeddings WHERE source_type='message' AND source_id=?", (r["id"],)
        ).fetchone()
        conn.close()
        assert row[0] == 1

    def test_auto_embed_atom(self, brain):
        aid = brain.create_atom("embed", "generates", "vector", "searchable")
        conn = sqlite3.connect(str(brain.db_path))
        row = conn.execute(
            "SELECT COUNT(*) FROM embeddings WHERE source_type='atom' AND source_id=?", (aid,)
        ).fetchone()
        conn.close()
        assert row[0] == 1


# ============================================================
# Auto-Extract (Messages → Atoms)
# ============================================================

class TestAutoExtract:
    def test_atom_tag(self, brain):
        """@atom subject | action | outcome | consequences"""
        r = brain.send("a", "b", "Tag", "@atom whales | accumulate | concentration visible | price moves")
        conn = sqlite3.connect(str(brain.db_path))
        rows = conn.execute(
            "SELECT subject FROM atoms WHERE source_message_id = ?", (r["id"],)
        ).fetchall()
        conn.close()
        assert len(rows) >= 1
        assert rows[0][0] == "whales"

    def test_causal_pattern_causes(self, brain):
        r = brain.send("a", "b", "Causal", "High volume causes price spikes in the market")
        conn = sqlite3.connect(str(brain.db_path))
        rows = conn.execute(
            "SELECT subject, outcome FROM atoms WHERE source_message_id = ?", (r["id"],)
        ).fetchall()
        conn.close()
        assert len(rows) >= 1

    def test_causal_pattern_leads_to(self, brain):
        r = brain.send("a", "b", "Causal", "Low liquidity leads to higher slippage costs")
        conn = sqlite3.connect(str(brain.db_path))
        rows = conn.execute(
            "SELECT COUNT(*) FROM atoms WHERE source_message_id = ?", (r["id"],)
        ).fetchone()
        conn.close()
        assert rows[0] >= 1

    def test_causal_cap_per_message(self, brain):
        """Max 3 atoms per message from causal patterns."""
        r = brain.send("a", "b", "Many",
            "A causes B. C causes D. E causes F. G causes H. I causes J.")
        conn = sqlite3.connect(str(brain.db_path))
        rows = conn.execute(
            "SELECT COUNT(*) FROM atoms WHERE source_message_id = ? AND source LIKE 'auto-extract%'",
            (r["id"],)
        ).fetchone()
        conn.close()
        assert rows[0] <= 3

    def test_extract_from_text(self, brain):
        ids = brain.extract_atoms_from_text("Heavy rainfall causes severe flooding downstream. Sustained heat leads to rapid evaporation of reservoirs.")
        assert len(ids) >= 1

    def test_no_extraction_on_normal(self, brain):
        """Normal messages shouldn't create atoms."""
        r = brain.send("a", "b", "Normal", "Just a regular message with no causal language")
        conn = sqlite3.connect(str(brain.db_path))
        rows = conn.execute(
            "SELECT COUNT(*) FROM atoms WHERE source_message_id = ?", (r["id"],)
        ).fetchone()
        conn.close()
        assert rows[0] == 0


# ============================================================
# Edge Cases
# ============================================================

class TestEdgeCases:
    def test_empty_search(self, brain):
        assert brain.unified_search("nonexistent_xyz_123") == []

    def test_remember_no_categories(self, brain):
        assert brain.remember("No cats").startswith("stm_")

    def test_send_no_subject(self, brain):
        r = brain.send("a", "b", None, "Body only")
        assert r["id"].startswith("syn_")

    def test_stats_structure(self, brain):
        s = brain.stats()
        for key in ["messages", "stm_entries", "atoms", "embeddings", "db_path"]:
            assert key in s

    def test_concurrent_writes(self, brain):
        ids = [brain.remember(f"C{i}", categories=["test"]) for i in range(20)]
        assert len(set(ids)) == 20


# ============================================================
# Helpers
# ============================================================

class TestHelpers:
    def test_gen_id_prefix(self):
        assert _gen_id("stm").startswith("stm_")
        assert _gen_id("syn").startswith("syn_")

    def test_gen_id_unique(self):
        assert len({_gen_id("t") for _ in range(100)}) == 100

    def test_now_iso(self):
        now = _now()
        assert "T" in now and len(now) > 20


# ============================================================
# Working Memory (SQLite-backed)
# ============================================================

class TestWorkingMemory:
    def test_pin_returns_id(self, brain):
        pin_id = brain.pin_working_memory("test", "Test content")
        assert pin_id.startswith("wm_")

    def test_get_empty(self, brain):
        assert brain.get_working_memory() == []

    def test_pin_and_get(self, brain):
        brain.pin_working_memory("first", "Content A")
        brain.pin_working_memory("second", "Content B")
        items = brain.get_working_memory()
        assert len(items) == 2
        assert items[0]["label"] == "first"
        assert items[1]["label"] == "second"
        assert items[0]["position"] < items[1]["position"]

    def test_unpin_by_index(self, brain):
        brain.pin_working_memory("a", "A")
        brain.pin_working_memory("b", "B")
        brain.pin_working_memory("c", "C")
        assert brain.unpin_working_memory("1") is True  # Remove "b"
        items = brain.get_working_memory()
        assert len(items) == 2
        labels = [i["label"] for i in items]
        assert "b" not in labels

    def test_unpin_by_id(self, brain):
        pin_id = brain.pin_working_memory("x", "X")
        assert brain.unpin_working_memory(pin_id) is True
        assert brain.get_working_memory() == []

    def test_unpin_nonexistent(self, brain):
        assert brain.unpin_working_memory("999") is False
        assert brain.unpin_working_memory("wm_nonexistent") is False

    def test_clear(self, brain):
        brain.pin_working_memory("a", "A")
        brain.pin_working_memory("b", "B")
        count = brain.clear_working_memory()
        assert count == 2
        assert brain.get_working_memory() == []

    def test_clear_empty(self, brain):
        assert brain.clear_working_memory() == 0

    def test_backward_compat_wm_pin(self, brain):
        result = brain.wm_pin("Content", label="Label")
        assert result["pinned"] is True
        assert result["total_pins"] == 1

    def test_backward_compat_wm_view(self, brain):
        brain.wm_pin("Content", label="Label")
        result = brain.wm_view()
        assert result["count"] == 1
        assert result["items"][0]["label"] == "Label"
        assert result["items"][0]["content"] == "Content"
        assert "pinnedAt" in result["items"][0]

    def test_backward_compat_wm_clear_index(self, brain):
        brain.wm_pin("A", label="a")
        brain.wm_pin("B", label="b")
        result = brain.wm_clear(index=0)
        assert result["cleared"] is True
        assert result["remaining"] == 1

    def test_backward_compat_wm_clear_all(self, brain):
        brain.wm_pin("A", label="a")
        result = brain.wm_clear()
        assert result["cleared"] is True
        assert result["items_removed"] == 1

    def test_stats_includes_wm(self, brain):
        brain.pin_working_memory("test", "content")
        s = brain.stats()
        assert s["working_memory_pins"] == 1


# ============================================================
# Categories (SQLite-backed)
# ============================================================

class TestCategories:
    def test_create_returns_true(self, brain):
        assert brain.create_category("trading", "Market analysis", ["trade", "market"]) is True

    def test_create_duplicate_returns_false(self, brain):
        brain.create_category("test_cat", "Test", ["test"])
        assert brain.create_category("test_cat", "Test 2", ["test"]) is False

    def test_list_empty(self, brain):
        assert brain.list_categories() == []

    def test_list_with_data(self, brain):
        brain.create_category("alpha", "First", ["a", "b"])
        brain.create_category("beta", "Second", ["c"])
        cats = brain.list_categories()
        assert len(cats) == 2
        names = [c["name"] for c in cats]
        assert "alpha" in names
        assert "beta" in names
        alpha = next(c for c in cats if c["name"] == "alpha")
        assert alpha["description"] == "First"
        assert alpha["keywords"] == ["a", "b"]
        assert "created_at" in alpha

    def test_delete(self, brain):
        brain.create_category("doomed", "To be deleted", [])
        assert brain.delete_category("doomed") is True
        assert brain.list_categories() == []

    def test_delete_nonexistent(self, brain):
        assert brain.delete_category("ghost") is False

    def test_stats_includes_categories(self, brain):
        brain.create_category("test_cat", "Test", ["test"])
        s = brain.stats()
        assert s["categories"] == 1

    def test_default_description(self, brain):
        brain.create_category("quick")
        cats = brain.list_categories()
        assert cats[0]["description"].startswith("User-created category")


# ============================================================
# Schema additions (tables exist)
# ============================================================

class TestSchemaAdditions:
    def test_working_memory_table_exists(self, brain):
        conn = sqlite3.connect(str(brain.db_path))
        tables = [r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()]
        conn.close()
        assert "working_memory" in tables

    def test_categories_table_exists(self, brain):
        conn = sqlite3.connect(str(brain.db_path))
        tables = [r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()]
        conn.close()
        assert "categories" in tables

    def test_working_memory_columns(self, brain):
        conn = sqlite3.connect(str(brain.db_path))
        cols = [r[1] for r in conn.execute("PRAGMA table_info(working_memory)").fetchall()]
        conn.close()
        for col in ["id", "label", "content", "pinned_at", "position"]:
            assert col in cols

    def test_categories_columns(self, brain):
        conn = sqlite3.connect(str(brain.db_path))
        cols = [r[1] for r in conn.execute("PRAGMA table_info(categories)").fetchall()]
        conn.close()
        for col in ["name", "description", "keywords", "created_at"]:
            assert col in cols


# ============================================================
# Migration
# ============================================================

class TestMigration:
    def test_migrate_empty(self, brain):
        result = brain.migrate_sidecars()
        assert result == {"working_memory": 0, "categories": 0}

    def test_migrate_working_memory(self, brain, tmp_path):
        # Create a fake working_memory.json in the db's parent dir
        wm_file = Path(brain.db_path).parent / "working_memory.json"
        wm_file.write_text(json.dumps({
            "items": [
                {"content": "Pin A", "label": "Label A", "pinnedAt": "2026-01-01T00:00:00"},
                {"content": "Pin B", "label": "Label B", "pinnedAt": "2026-01-02T00:00:00"},
            ]
        }))
        result = brain.migrate_sidecars()
        assert result["working_memory"] == 2
        items = brain.get_working_memory()
        assert len(items) == 2
        assert items[0]["label"] == "Label A"

    def test_migrate_categories(self, brain, tmp_path):
        cats_file = Path(brain.db_path).parent / "categories.json"
        cats_file.write_text(json.dumps({
            "categories": {
                "trading": {"description": "Market stuff", "keywords": ["trade", "market"]},
                "coding": {"description": "Dev stuff", "keywords": ["code", "debug"]},
            },
            "extensible": True,
        }))
        result = brain.migrate_sidecars()
        assert result["categories"] == 2
        cats = brain.list_categories()
        assert len(cats) == 2
        names = [c["name"] for c in cats]
        assert "trading" in names

    def test_migrate_idempotent(self, brain, tmp_path):
        wm_file = Path(brain.db_path).parent / "working_memory.json"
        wm_file.write_text(json.dumps({
            "items": [{"content": "Pin A", "label": "A", "pinnedAt": "2026-01-01T00:00:00"}]
        }))
        brain.migrate_sidecars()
        result = brain.migrate_sidecars()
        assert result["working_memory"] == 0  # Already migrated
        assert len(brain.get_working_memory()) == 1  # Still just one

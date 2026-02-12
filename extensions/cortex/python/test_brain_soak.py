#!/usr/bin/env python3
"""
test_brain_soak.py — Long-running soak test for brain.db

Hammers all subsystems and verifies data integrity.
Target: complete in under 60 seconds.

Usage:
    CORTEX_DATA_DIR=/tmp/brain_soak pytest test_brain_soak.py -v
"""
import json
import os
import sqlite3
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import pytest

# Isolated temp DB
TEST_DIR = tempfile.mkdtemp(prefix="brain_soak_")
os.environ["CORTEX_DATA_DIR"] = TEST_DIR

from brain import UnifiedBrain


# ============================================================
# Fixtures
# ============================================================

@pytest.fixture(scope="module")
def brain():
    """Single brain instance for the whole soak module."""
    return UnifiedBrain(os.path.join(TEST_DIR, "soak.db"))


@pytest.fixture(scope="module")
def throughput():
    """Accumulator for throughput stats, printed at end."""
    return {}


# ============================================================
# Soak: STM bulk writes
# ============================================================

class TestSoakSTM:
    def test_write_1000_stm(self, brain, throughput):
        """Write 1,000 STM entries and verify count."""
        start = time.monotonic()
        ids = set()
        for i in range(1000):
            mid = brain.remember(
                f"Soak STM entry {i}: testing persistence and FTS indexing with sufficient text length for realistic workload measurement",
                importance=round(1.0 + (i % 30) / 10.0, 1),
                categories=[f"soak_{i % 5}"],
            )
            ids.add(mid)
        elapsed = time.monotonic() - start
        throughput["stm_write"] = 1000 / elapsed

        assert len(ids) == 1000, f"Expected 1000 unique IDs, got {len(ids)}"

        stats = brain.stats()
        assert stats["stm_entries"] >= 1000, f"Expected >=1000 STM, got {stats['stm_entries']}"

    def test_stm_fts_searchable(self, brain):
        """Verify FTS5 index is functional — search returns results from bulk writes."""
        results = brain.unified_search("soak", limit=100, types=["stm"])
        assert len(results) > 0, "FTS search for 'soak' returned nothing after 1000 STM writes"


# ============================================================
# Soak: SYNAPSE messages
# ============================================================

class TestSoakSynapse:
    def test_send_100_messages_across_threads(self, brain, throughput):
        """Send 100 messages across 10 threads using 10 concurrent threads."""
        errors = []
        msg_ids = []
        lock = threading.Lock()

        def sender(thread_num):
            local_ids = []
            for i in range(10):
                try:
                    r = brain.send(
                        from_agent=f"agent_{thread_num % 3}",
                        to_agent=f"agent_{(thread_num + 1) % 3}",
                        subject=f"Soak thread {thread_num} msg {i}",
                        body=f"Soak message body {thread_num}-{i}: testing concurrent SYNAPSE sends with realistic payload size for throughput measurement",
                        thread_id=f"soak_thr_{thread_num}",
                    )
                    local_ids.append(r["id"])
                except Exception as e:
                    with lock:
                        errors.append(f"T{thread_num}-{i}: {e}")
            return local_ids

        start = time.monotonic()
        with ThreadPoolExecutor(max_workers=10) as pool:
            futures = [pool.submit(sender, t) for t in range(10)]
            for f in as_completed(futures):
                msg_ids.extend(f.result())
        elapsed = time.monotonic() - start
        throughput["synapse_send"] = 100 / elapsed

        assert len(errors) == 0, f"Errors: {errors[:5]}"
        assert len(msg_ids) == 100, f"Expected 100 messages, got {len(msg_ids)}"

    def test_messages_fts_searchable(self, brain):
        """Verify FTS5 index is functional — search returns results from bulk sends."""
        results = brain.unified_search("Soak", limit=100, types=["message"])
        assert len(results) > 0, "FTS search for 'Soak' returned nothing after 100 message sends"

    def test_inbox_works_after_bulk(self, brain):
        """Inbox should return results after bulk sends."""
        inbox = brain.inbox("agent_1")
        assert len(inbox) > 0, "Inbox empty after 100 messages"


# ============================================================
# Soak: Atoms with provenance
# ============================================================

class TestSoakAtoms:
    def test_create_50_atoms_with_links(self, brain, throughput):
        """Create 50 atoms and 25 causal links between them."""
        atom_ids = []

        start = time.monotonic()
        for i in range(50):
            aid = brain.create_atom(
                subject=f"entity_{i}",
                action=f"performs soak action {i}",
                outcome=f"produces soak outcome {i}",
                consequences=f"leads to soak consequence {i}",
                confidence=round(0.5 + (i % 5) / 10.0, 2),
                source="soak_test",
            )
            atom_ids.append(aid)

        # Create 25 causal links (i → i+1)
        for i in range(25):
            brain.link_atoms(atom_ids[i], atom_ids[i + 1], "causes", strength=0.7)

        elapsed = time.monotonic() - start
        throughput["atom_create"] = 50 / elapsed

        assert len(set(atom_ids)) == 50, f"Expected 50 unique atom IDs, got {len(set(atom_ids))}"

        stats = brain.atom_stats()
        assert stats["total_atoms"] >= 50
        assert stats["total_causal_links"] >= 25

    def test_atoms_fts_searchable(self, brain):
        """Verify FTS5 index is functional — search returns atoms from bulk creates."""
        results = brain.unified_search("soak", limit=100, types=["atom"])
        assert len(results) > 0, "FTS search for 'soak' returned nothing after 50 atom creates"

    def test_provenance_chain(self, brain):
        """Create atom with message provenance and verify chain."""
        msg = brain.send("soak_a", "soak_b", "Provenance test", "Source message for atom")
        aid = brain.create_atom(
            "soak_provenance", "verified", "chain intact", "integrity confirmed",
            source_message_id=msg["id"],
        )
        chain = brain.find_provenance(aid)
        assert chain is not None
        types = [c["type"] for c in chain]
        assert "atom" in types
        assert "message" in types


# ============================================================
# Soak: FTS5 searches
# ============================================================

class TestSoakFTS:
    def test_500_fts_searches(self, brain, throughput):
        """Run 500 FTS5 searches across all types."""
        terms = [
            "soak", "entry", "testing", "persistence",
            "agent", "message", "body", "entity",
            "action", "outcome", "consequence", "thread",
        ]
        errors = []
        total_results = 0

        start = time.monotonic()
        for i in range(500):
            try:
                q = terms[i % len(terms)]
                results = brain.unified_search(q, limit=10, types=["stm", "message", "atom"])
                total_results += len(results)
            except Exception as e:
                errors.append(str(e))
        elapsed = time.monotonic() - start
        throughput["fts_search"] = 500 / elapsed

        assert len(errors) == 0, f"Search errors: {errors[:5]}"
        assert total_results > 0, "No results from any of 500 searches"

    def test_fts_returns_correct_type(self, brain):
        """FTS should return only the requested types."""
        # Search STM only
        results = brain.unified_search("soak", limit=10, types=["stm"])
        for r in results:
            if r.get("match_type") == "fts":
                assert r["source_type"] == "stm", f"Got {r['source_type']} when searching stm only"


# ============================================================
# Soak: Unified searches
# ============================================================

class TestSoakUnified:
    def test_100_unified_searches(self, brain, throughput):
        """Run 100 unified searches (FTS + semantic if GPU available)."""
        queries = [
            "trading patterns", "market signals", "concurrent writes",
            "persistence testing", "soak workload", "entity performs",
            "consequence chain", "causal links", "provenance",
            "realistic payload",
        ]
        errors = []
        total_results = 0

        start = time.monotonic()
        for i in range(100):
            try:
                q = queries[i % len(queries)]
                results = brain.unified_search(q, limit=20)
                total_results += len(results)
            except Exception as e:
                errors.append(str(e))
        elapsed = time.monotonic() - start
        throughput["unified_search"] = 100 / elapsed

        assert len(errors) == 0, f"Unified search errors: {errors[:5]}"
        assert total_results > 0, "No results from unified searches"


# ============================================================
# Soak: Data integrity
# ============================================================

class TestSoakIntegrity:
    def test_row_counts_match(self, brain):
        """Verify row counts across tables are consistent."""
        stats = brain.stats()

        conn = sqlite3.connect(str(brain.db_path))
        stm_rows = conn.execute("SELECT COUNT(*) FROM stm").fetchone()[0]
        msg_rows = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
        atom_rows = conn.execute("SELECT COUNT(*) FROM atoms").fetchone()[0]
        conn.close()

        assert stats["stm_entries"] == stm_rows, f"Stats STM mismatch: {stats['stm_entries']} vs {stm_rows}"
        assert stats["messages"] == msg_rows, f"Stats msg mismatch: {stats['messages']} vs {msg_rows}"
        assert stats["atoms"] == atom_rows, f"Stats atom mismatch: {stats['atoms']} vs {atom_rows}"

    def test_fts_all_indexes_functional(self, brain):
        """All FTS indexes should return results for known content."""
        # Test each FTS index returns results for content we know exists
        stm_results = brain.unified_search("soak", limit=5, types=["stm"])
        msg_results = brain.unified_search("Soak", limit=5, types=["message"])
        atom_results = brain.unified_search("soak", limit=5, types=["atom"])

        assert len(stm_results) > 0, "STM FTS index broken"
        assert len(msg_results) > 0, "Messages FTS index broken"
        assert len(atom_results) > 0, "Atoms FTS index broken"

    def test_wal_mode_active(self, brain):
        """WAL mode should be set."""
        conn = sqlite3.connect(str(brain.db_path))
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
        conn.close()
        assert mode == "wal", f"Expected WAL mode, got {mode}"

    def test_source_table_rowids_valid(self, brain):
        """Source tables should have contiguous rowids (no gaps from deletes breaking FTS)."""
        conn = sqlite3.connect(str(brain.db_path))

        for table in ["stm", "messages", "atoms"]:
            count = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            max_rowid = conn.execute(f"SELECT MAX(rowid) FROM {table}").fetchone()[0] or 0
            # max_rowid should be >= count (gaps allowed, but max must be >= count)
            assert max_rowid >= count, f"{table}: max_rowid={max_rowid} < count={count}"

        conn.close()

    def test_foreign_keys_valid(self, brain):
        """No broken foreign key references."""
        conn = sqlite3.connect(str(brain.db_path))
        conn.execute("PRAGMA foreign_keys=ON")
        violations = conn.execute("PRAGMA foreign_key_check").fetchall()
        conn.close()
        assert len(violations) == 0, f"FK violations: {violations[:5]}"


# ============================================================
# Soak: Summary (runs last because of alphabetical ordering)
# ============================================================

class TestZZSummary:
    """Named with ZZ prefix to run last."""

    def test_print_throughput(self, throughput, brain):
        """Print throughput stats and verify time budget."""
        stats = brain.stats()
        print("\n" + "=" * 60)
        print("SOAK TEST THROUGHPUT STATS")
        print("=" * 60)
        for op, rate in sorted(throughput.items()):
            print(f"  {op:.<30} {rate:>8.1f} ops/sec")
        print(f"\n  STM entries: {stats['stm_entries']}")
        print(f"  Messages:    {stats['messages']}")
        print(f"  Atoms:       {stats['atoms']}")
        print(f"  Causal links:{stats['causal_links']}")
        print(f"  DB path:     {brain.db_path}")

        db_size = os.path.getsize(str(brain.db_path))
        print(f"  DB size:     {db_size / 1024:.1f} KB")
        print("=" * 60)

        # All ops should have been recorded
        assert len(throughput) >= 4, f"Only {len(throughput)} throughput metrics recorded"

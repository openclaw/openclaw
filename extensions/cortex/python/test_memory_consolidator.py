"""
Tests for memory_consolidator.py

Usage:
    CORTEX_DATA_DIR=/tmp/consolidator_test pytest test_memory_consolidator.py -v --tb=short
"""
import json
import os
import sqlite3
import tempfile
from pathlib import Path
from unittest.mock import patch, MagicMock

import numpy as np
import pytest

# Force test data dir
TEST_DIR = tempfile.mkdtemp(prefix="consolidator_test_")
os.environ["CORTEX_DATA_DIR"] = TEST_DIR

from memory_consolidator import (
    cluster_entries,
    consolidate,
    load_stm_with_embeddings,
    _cosine,
    _blob_to_vec,
    _ollama_synthesize,
)
from brain import UnifiedBrain


# ============================================================
# Fixtures
# ============================================================

@pytest.fixture
def brain(tmp_path):
    return UnifiedBrain(str(tmp_path / "test.db"))


def _make_entry(id: str, content: str, vec: np.ndarray, importance: float = 1.0):
    """Create a fake STM entry dict for clustering tests."""
    return {
        "id": id,
        "content": content,
        "categories": '["test"]',
        "importance": importance,
        "created_at": "2026-01-01T00:00:00",
        "access_count": 0,
        "embedding": vec,
    }


def _similar_vec(base: np.ndarray, noise: float = 0.01) -> np.ndarray:
    """Create a vector similar to base with small noise."""
    noisy = base + np.random.randn(*base.shape).astype(np.float32) * noise
    return noisy / np.linalg.norm(noisy)


def _random_unit_vec(dim: int = 384) -> np.ndarray:
    v = np.random.randn(dim).astype(np.float32)
    return v / np.linalg.norm(v)


# ============================================================
# Tests
# ============================================================

class TestCosine:
    def test_identical_vectors(self):
        v = _random_unit_vec()
        assert abs(_cosine(v, v) - 1.0) < 0.001

    def test_orthogonal_vectors(self):
        a = np.array([1.0, 0.0, 0.0], dtype=np.float32)
        b = np.array([0.0, 1.0, 0.0], dtype=np.float32)
        assert abs(_cosine(a, b)) < 0.001


class TestClustering:
    def test_single_cluster_similar_entries(self):
        base = _random_unit_vec()
        entries = [
            _make_entry("stm_1", "Content A", _similar_vec(base, 0.01)),
            _make_entry("stm_2", "Content B", _similar_vec(base, 0.01)),
            _make_entry("stm_3", "Content C", _similar_vec(base, 0.01)),
        ]
        clusters = cluster_entries(entries, threshold=0.85)
        # All should be in one cluster
        big = [c for c in clusters if len(c) >= 3]
        assert len(big) == 1
        assert len(big[0]) == 3

    def test_two_distinct_clusters(self):
        base1 = _random_unit_vec()
        base2 = -base1  # Opposite direction = very dissimilar
        entries = [
            _make_entry("stm_1", "A1", _similar_vec(base1, 0.01)),
            _make_entry("stm_2", "A2", _similar_vec(base1, 0.01)),
            _make_entry("stm_3", "A3", _similar_vec(base1, 0.01)),
            _make_entry("stm_4", "B1", _similar_vec(base2, 0.01)),
            _make_entry("stm_5", "B2", _similar_vec(base2, 0.01)),
            _make_entry("stm_6", "B3", _similar_vec(base2, 0.01)),
        ]
        clusters = cluster_entries(entries, threshold=0.85)
        big = [c for c in clusters if len(c) >= 3]
        assert len(big) == 2

    def test_no_clusters_when_all_different(self):
        entries = [
            _make_entry(f"stm_{i}", f"C{i}", _random_unit_vec())
            for i in range(5)
        ]
        clusters = cluster_entries(entries, threshold=0.99)
        big = [c for c in clusters if len(c) >= 3]
        assert len(big) == 0

    def test_min_cluster_size_filtering(self):
        base = _random_unit_vec()
        entries = [
            _make_entry("stm_1", "A", _similar_vec(base, 0.01)),
            _make_entry("stm_2", "B", _similar_vec(base, 0.01)),
        ]
        clusters = cluster_entries(entries, threshold=0.85)
        # Only 2 entries — should form one cluster of 2
        assert len(clusters) == 1
        assert len(clusters[0]) == 2


class TestConsolidate:
    @patch("memory_consolidator._ollama_synthesize")
    @patch("memory_consolidator._embed_text")
    def test_dry_run_returns_clusters(self, mock_embed, mock_ollama, brain):
        """Dry run should find clusters but not write anything."""
        mock_embed.return_value = None  # Embeddings handled manually

        # Manually insert STM entries with embeddings
        base = _random_unit_vec()
        conn = sqlite3.connect(str(brain.db_path))
        for i in range(4):
            stm_id = f"stm_test_{i}"
            vec = _similar_vec(base, 0.005)
            conn.execute(
                "INSERT INTO stm (id, content, categories, importance, created_at, source) VALUES (?, ?, ?, ?, ?, ?)",
                (stm_id, f"Similar content about topic X variant {i}", '["test"]', 1.0, "2026-01-01T00:00:00", "agent"),
            )
            conn.execute(
                "INSERT OR REPLACE INTO embeddings (id, source_type, source_id, content, embedding, model, created_at) VALUES (?, 'stm', ?, ?, ?, 'all-MiniLM-L6-v2', ?)",
                (f"emb_test_{i}", stm_id, f"content {i}", vec.tobytes(), "2026-01-01T00:00:00"),
            )
        conn.commit()
        conn.close()

        result = consolidate(
            db_path=str(brain.db_path),
            threshold=0.85,
            min_cluster_size=3,
            dry_run=True,
        )
        assert result["clusters_found"] >= 1
        assert result["entries_consolidated"] >= 3
        assert result["new_memories"] == 0  # Dry run

    @patch("memory_consolidator._ollama_synthesize")
    @patch("memory_consolidator._embed_text")
    def test_consolidation_creates_new_memory(self, mock_embed, mock_ollama, brain):
        """Full consolidation should create a new consolidated memory."""
        mock_embed.return_value = None
        mock_ollama.return_value = "Consolidated: topic X appears across all entries with variants"

        base = _random_unit_vec()
        conn = sqlite3.connect(str(brain.db_path))
        for i in range(3):
            stm_id = f"stm_cons_{i}"
            vec = _similar_vec(base, 0.005)
            conn.execute(
                "INSERT INTO stm (id, content, categories, importance, created_at, source) VALUES (?, ?, ?, ?, ?, ?)",
                (stm_id, f"Topic X detail {i}", '["test"]', 1.5, "2026-01-01T00:00:00", "agent"),
            )
            conn.execute(
                "INSERT OR REPLACE INTO embeddings (id, source_type, source_id, content, embedding, model, created_at) VALUES (?, 'stm', ?, ?, ?, 'all-MiniLM-L6-v2', ?)",
                (f"emb_cons_{i}", stm_id, f"content {i}", vec.tobytes(), "2026-01-01T00:00:00"),
            )
        conn.commit()
        conn.close()

        result = consolidate(
            db_path=str(brain.db_path),
            threshold=0.85,
            min_cluster_size=3,
            dry_run=False,
        )
        assert result["new_memories"] >= 1
        # Verify the new memory exists
        new_id = result["clusters"][0]["consolidated_id"]
        assert new_id is not None
        assert new_id.startswith("stm_")

        # Check source contains consolidated_from metadata
        conn = sqlite3.connect(str(brain.db_path))
        row = conn.execute("SELECT source, importance FROM stm WHERE id = ?", (new_id,)).fetchone()
        conn.close()
        assert row is not None
        assert "consolidated_from" in row[0]
        assert row[1] >= 2.0  # importance bumped

    @patch("memory_consolidator._ollama_synthesize")
    @patch("memory_consolidator._embed_text")
    def test_ollama_failure_uses_fallback(self, mock_embed, mock_ollama, brain):
        """When Ollama fails, should concatenate entries as fallback."""
        mock_embed.return_value = None
        mock_ollama.return_value = None  # Simulate Ollama failure

        base = _random_unit_vec()
        conn = sqlite3.connect(str(brain.db_path))
        for i in range(3):
            stm_id = f"stm_fb_{i}"
            vec = _similar_vec(base, 0.005)
            conn.execute(
                "INSERT INTO stm (id, content, categories, importance, created_at, source) VALUES (?, ?, ?, ?, ?, ?)",
                (stm_id, f"Fallback entry {i}", '["test"]', 1.0, "2026-01-01T00:00:00", "agent"),
            )
            conn.execute(
                "INSERT OR REPLACE INTO embeddings (id, source_type, source_id, content, embedding, model, created_at) VALUES (?, 'stm', ?, ?, ?, 'all-MiniLM-L6-v2', ?)",
                (f"emb_fb_{i}", stm_id, f"content {i}", vec.tobytes(), "2026-01-01T00:00:00"),
            )
        conn.commit()
        conn.close()

        result = consolidate(
            db_path=str(brain.db_path),
            threshold=0.85,
            min_cluster_size=3,
            dry_run=False,
        )
        assert result["new_memories"] >= 1
        # Verify fallback content (concatenation)
        new_id = result["clusters"][0]["consolidated_id"]
        conn = sqlite3.connect(str(brain.db_path))
        row = conn.execute("SELECT content FROM stm WHERE id = ?", (new_id,)).fetchone()
        conn.close()
        assert "Fallback entry" in row[0]


class TestLoadSTM:
    def test_load_returns_entries_with_embeddings(self, brain):
        """Only STM entries with embeddings are loaded."""
        # Insert one with embedding and one without
        base = _random_unit_vec()
        conn = sqlite3.connect(str(brain.db_path))
        conn.execute(
            "INSERT INTO stm (id, content, categories, importance, created_at, source) VALUES (?, ?, ?, ?, ?, ?)",
            ("stm_with_emb", "Has embedding", '["test"]', 1.0, "2026-01-01T00:00:00", "agent"),
        )
        conn.execute(
            "INSERT OR REPLACE INTO embeddings (id, source_type, source_id, content, embedding, model, created_at) VALUES (?, 'stm', ?, ?, ?, 'all-MiniLM-L6-v2', ?)",
            ("emb_1", "stm_with_emb", "Has embedding", base.tobytes(), "2026-01-01T00:00:00"),
        )
        conn.execute(
            "INSERT INTO stm (id, content, categories, importance, created_at, source) VALUES (?, ?, ?, ?, ?, ?)",
            ("stm_no_emb", "No embedding", '["test"]', 1.0, "2026-01-01T00:00:00", "agent"),
        )
        conn.commit()
        conn.close()

        entries = load_stm_with_embeddings(str(brain.db_path))
        ids = [e["id"] for e in entries]
        assert "stm_with_emb" in ids
        assert "stm_no_emb" not in ids

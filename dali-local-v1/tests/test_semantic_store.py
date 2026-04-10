import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import semantic_store
from memory_store import append_reflection, bootstrap_workspace


class SemanticStoreTests(unittest.TestCase):
    def test_default_embed_is_deterministic(self) -> None:
        first = semantic_store.default_embed("same text", vector_size=12)
        second = semantic_store.default_embed("same text", vector_size=12)
        other = semantic_store.default_embed("other text", vector_size=12)

        self.assertEqual(first, second)
        self.assertEqual(len(first), 12)
        self.assertNotEqual(first, other)
        self.assertLessEqual(max(abs(v) for v in first), 1.0)

    def test_embedding_of_empty_text(self) -> None:
        vector = semantic_store.default_embed("", vector_size=7)
        self.assertEqual(vector, [0.0] * 7)

    def test_build_reflection_points_from_rows(self) -> None:
        reflections = [
            {
                "id": "r1",
                "created_at": "2026-04-10T00:00:00Z",
                "source_event_id": "e1",
                "reflection_text": "What a bright day",
                "durable_claims_json": '["insight", "signal"]',
                "uncertainties_json": '["open question"]',
                "interdisciplinary_links_json": '["psychology"]',
                "nca_signal": "low",
                "creative_fragment": None,
                "memory_candidate_score": 0.74,
                "payload_json": '{"source":"test"}',
            },
        ]
        points = semantic_store.build_reflection_points(reflections, vector_size=8)

        self.assertEqual(len(points), 1)
        self.assertEqual(points[0]["id"], "r1")
        self.assertEqual(len(points[0]["vector"]), 8)
        self.assertIn("payload", points[0])
        self.assertEqual(points[0]["payload"]["reflection_text"], "What a bright day")
        self.assertEqual(points[0]["payload"]["durable_claims"], ["insight", "signal"])

    def test_index_reflections_can_run_dry_run(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "dali-local-v1"
            bootstrap_workspace(root)
            db_path = Path(root) / "state" / "dali.sqlite3"

            append_reflection(
                db_path,
                source_event_id=None,
                reflection_text="Dry-run integration candidate",
                durable_claims=["claim"],
                uncertainties=["u"],
                interdisciplinary_links=["x"],
                payload={"source": "pytest"},
            )

            summary = semantic_store.index_reflections_in_qdrant(
                db_path,
                qdrant_url="http://localhost:6333",
                collection="dali_local_v1_reflections_test",
                vector_size=16,
                limit=10,
                dry_run=True,
                refresh=True,
                timeout_seconds=2.0,
            )

            self.assertTrue(summary["dryRun"])
            self.assertEqual(summary["reflections"], 1)
            self.assertEqual(summary["upserted"], 1)


if __name__ == "__main__":
    unittest.main()

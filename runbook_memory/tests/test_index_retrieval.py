from __future__ import annotations

import json
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch

from runbook_memory.frontmatter import build_default_frontmatter, dump_frontmatter
from runbook_memory.indexer import index_markdown_file
from runbook_memory.retrieval import search
from runbook_memory.schema import open_database


class IndexRetrievalTests(unittest.TestCase):
    def test_index_and_search_smoke(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            runbooks_root = root / "runbooks"
            docs_root = root / "docs"
            db_path = root / "db.sqlite3"
            docs_root.mkdir()
            runbooks_root.mkdir()
            conn = open_database(db_path)

            metadata = build_default_frontmatter(
                title="Signal Queue Backpressure",
                doc_type="incident_runbook",
                lifecycle_state="active",
                service="signal",
                feature="queue",
                plugin="signal",
                environments=["prod"],
                provenance_source_ref=str(docs_root / "signal-queue.md"),
                aliases=["signal-queue-backpressure"],
                retrieval_synopsis="Recover Signal queue backpressure in prod.",
                retrieval_hints=["message delivery lag", "throttling"],
                retrieval_not_for=["oauth refresh"],
                retrieval_commands=["openclaw channels status --probe"],
            )
            body = (
                "# Purpose\n\n"
                "Mitigate queue backpressure when Signal deliveries slow down.\n\n"
                "# Triage\n\n"
                "Check for backpressure, retry loops, and message delivery lag.\n"
            )
            source = docs_root / "signal-queue.md"
            source.write_text(dump_frontmatter(metadata) + body, encoding="utf-8")

            indexed = index_markdown_file(conn, source, runbooks_root=runbooks_root)
            self.assertEqual(indexed["doc_id"], metadata["doc_id"])

            result = search(conn, "queue backpressure Signal", top_k=3)
            self.assertTrue(result["top_docs"])
            self.assertEqual(result["top_docs"][0]["doc_id"], metadata["doc_id"])
            self.assertGreaterEqual(result["confidence"], 0.05)

            alias_result = search(conn, "signal-queue-backpressure", top_k=3)
            self.assertTrue(alias_result["top_docs"])
            self.assertEqual(alias_result["top_docs"][0]["doc_id"], metadata["doc_id"])

    def test_semantic_candidates_extend_beyond_fts(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            runbooks_root = root / "runbooks"
            docs_root = root / "docs"
            db_path = root / "db.sqlite3"
            docs_root.mkdir()
            runbooks_root.mkdir()
            conn = open_database(db_path)
            today = date.today().isoformat()

            lexical_metadata = build_default_frontmatter(
                title="Queue Backpressure",
                doc_type="incident_runbook",
                lifecycle_state="active",
                service="signal",
                feature="queue",
                plugin="signal",
                environments=["prod"],
                provenance_source_ref=str(docs_root / "queue-backpressure.md"),
                validation_last_validated_at=today,
                retrieval_synopsis="Recover queue backpressure in prod.",
            )
            lexical_source = docs_root / "queue-backpressure.md"
            lexical_source.write_text(
                dump_frontmatter(lexical_metadata) + "# Purpose\n\nQueue backpressure in prod.\n",
                encoding="utf-8",
            )
            index_markdown_file(conn, lexical_source, runbooks_root=runbooks_root)
            lexical_chunk_id = conn.execute(
                "SELECT chunk_id FROM chunks WHERE doc_id = ?",
                (lexical_metadata["doc_id"],),
            ).fetchone()["chunk_id"]

            semantic_metadata = build_default_frontmatter(
                title="Delivery Lag",
                doc_type="incident_runbook",
                lifecycle_state="active",
                service="signal",
                feature="delivery",
                plugin="signal",
                environments=["prod"],
                provenance_source_ref=str(docs_root / "delivery-lag.md"),
                validation_last_validated_at=today,
                retrieval_synopsis="Investigate delivery lag during throughput drops.",
            )
            semantic_source = docs_root / "delivery-lag.md"
            semantic_source.write_text(
                dump_frontmatter(semantic_metadata) + "# Purpose\n\nInvestigate throughput drops and routing delays.\n",
                encoding="utf-8",
            )
            index_markdown_file(conn, semantic_source, runbooks_root=runbooks_root)
            semantic_chunk_id = conn.execute(
                "SELECT chunk_id FROM chunks WHERE doc_id = ?",
                (semantic_metadata["doc_id"],),
            ).fetchone()["chunk_id"]

            conn.executemany(
                """
                INSERT INTO chunk_embeddings(chunk_id, model_name, vector_json, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(chunk_id) DO UPDATE SET
                    model_name=excluded.model_name,
                    vector_json=excluded.vector_json,
                    updated_at=excluded.updated_at
                """,
                [
                    (lexical_chunk_id, "test-model", json.dumps([0.0, 1.0]), today),
                    (semantic_chunk_id, "test-model", json.dumps([1.0, 0.0]), today),
                ],
            )
            conn.commit()

            with patch("runbook_memory.retrieval._query_vector", return_value=[1.0, 0.0]):
                result = search(conn, "Queue Backpressure", top_k=2, embedding_model="test-model")

            top_doc_ids = [doc["doc_id"] for doc in result["top_docs"]]
            self.assertEqual(top_doc_ids[0], lexical_metadata["doc_id"])
            self.assertIn(semantic_metadata["doc_id"], top_doc_ids)

            top_chunk_ids = [chunk["chunk_id"] for chunk in result["top_chunks"]]
            self.assertEqual(len(top_chunk_ids), len(set(top_chunk_ids)))

    def test_top_docs_use_doc_scores_not_only_top_chunks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            runbooks_root = root / "runbooks"
            docs_root = root / "docs"
            db_path = root / "db.sqlite3"
            docs_root.mkdir()
            runbooks_root.mkdir()
            conn = open_database(db_path)
            today = date.today().isoformat()

            dominant_metadata = build_default_frontmatter(
                title="Alpha Routing",
                doc_type="incident_runbook",
                lifecycle_state="active",
                service="alpha",
                feature="routing",
                provenance_source_ref=str(docs_root / "alpha-routing.md"),
                validation_last_validated_at=today,
                retrieval_synopsis="Alpha routing notes.",
            )
            dominant_source = docs_root / "alpha-routing.md"
            dominant_source.write_text(
                dump_frontmatter(dominant_metadata)
                + "# Purpose\n\nAlpha routing alpha routing alpha.\n\n# Triage\n\nAlpha routing retries alpha.\n",
                encoding="utf-8",
            )
            index_markdown_file(conn, dominant_source, runbooks_root=runbooks_root)

            secondary_metadata = build_default_frontmatter(
                title="Beta Service",
                doc_type="incident_runbook",
                lifecycle_state="active",
                service="beta",
                feature="service",
                provenance_source_ref=str(docs_root / "beta-service.md"),
                validation_last_validated_at=today,
                retrieval_synopsis="Beta service mentions alpha dependencies.",
            )
            secondary_source = docs_root / "beta-service.md"
            secondary_source.write_text(
                dump_frontmatter(secondary_metadata)
                + "# Purpose\n\nBeta service checks alpha dependency status.\n",
                encoding="utf-8",
            )
            index_markdown_file(conn, secondary_source, runbooks_root=runbooks_root)

            result = search(conn, "alpha routing", top_k=2)
            top_doc_ids = [doc["doc_id"] for doc in result["top_docs"]]

            self.assertEqual(top_doc_ids[0], dominant_metadata["doc_id"])
            self.assertIn(secondary_metadata["doc_id"], top_doc_ids)

    def test_document_authoring_intent_beats_generic_documents_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            runbooks_root = root / "runbooks"
            docs_root = root / "docs"
            db_path = root / "db.sqlite3"
            docs_root.mkdir()
            runbooks_root.mkdir()
            conn = open_database(db_path)
            today = date.today().isoformat()

            authoring_metadata = build_default_frontmatter(
                title="Machine-first runbook style guide",
                doc_type="reference_card",
                lifecycle_state="active",
                service="runbook-memory",
                feature="authoring",
                plugin="runbook-memory",
                environments=["all"],
                provenance_source_ref=str(docs_root / "machine-style.md"),
                validation_last_validated_at=today,
                aliases=["document this", "create a runbook"],
                retrieval_synopsis="Canonical authoring rules for machine-first runbooks and injected workspace docs.",
                retrieval_hints=["document this in Documents", "update or create documentation"],
            )
            authoring_source = docs_root / "machine-style.md"
            authoring_source.write_text(
                dump_frontmatter(authoring_metadata)
                + "# Purpose\n\nUse this when the user asks to document what changed.\n",
                encoding="utf-8",
            )
            index_markdown_file(conn, authoring_source, runbooks_root=runbooks_root)

            path_metadata = build_default_frontmatter(
                title="OpenClaw Path Map",
                doc_type="reference_card",
                lifecycle_state="active",
                service="openclaw-gateway",
                feature="config-locations",
                environments=["operator-desktop"],
                provenance_source_ref=str(docs_root / "path-map.md"),
                validation_last_validated_at=today,
                retrieval_synopsis="Path map for OpenClaw config files.",
            )
            path_source = docs_root / "path-map.md"
            path_source.write_text(
                dump_frontmatter(path_metadata)
                + "# Purpose\n\nRelated docs live in /home/example/Documents/openclaw-safe-install/README.md.\n",
                encoding="utf-8",
            )
            index_markdown_file(conn, path_source, runbooks_root=runbooks_root)

            result = search(conn, "document this in /Documents", top_k=2)

            self.assertEqual(result["top_docs"][0]["doc_id"], authoring_metadata["doc_id"])
            self.assertIn("document authoring intent", result["top_docs"][0]["why_matched"])

    def test_partial_path_keeps_textual_candidates(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            runbooks_root = root / "runbooks"
            docs_root = root / "docs"
            db_path = root / "db.sqlite3"
            docs_root.mkdir()
            runbooks_root.mkdir()
            conn = open_database(db_path)
            today = date.today().isoformat()

            metadata = build_default_frontmatter(
                title="Open Claw Safe Install",
                doc_type="ops_sop",
                lifecycle_state="active",
                service="openclaw-gateway",
                feature="safe-host-deployment",
                environments=["operator-desktop"],
                provenance_source_ref=str(docs_root / "safe-install.md"),
                validation_last_validated_at=today,
                retrieval_synopsis="Safe install plan for open claw on a home network.",
            )
            source = docs_root / "safe-install.md"
            source.write_text(
                dump_frontmatter(metadata) + "# Purpose\n\nRead this after open claw is installed safely.\n",
                encoding="utf-8",
            )
            index_markdown_file(conn, source, runbooks_root=runbooks_root)

            result = search(conn, "I installed open claw, read docs in /Documents/op", top_k=2)

            self.assertTrue(result["top_docs"])
            self.assertEqual(result["top_docs"][0]["doc_id"], metadata["doc_id"])


if __name__ == "__main__":
    unittest.main()

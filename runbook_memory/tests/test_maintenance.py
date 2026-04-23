from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from runbook_memory.frontmatter import build_default_frontmatter, dump_frontmatter
from runbook_memory.indexer import index_markdown_file
from runbook_memory.maintenance import (
    eval_label_queue,
    eval_suite,
    health_report,
    low_confidence_review_queue,
    update_eval_label,
)
from runbook_memory.schema import open_database


class MaintenanceTests(unittest.TestCase):
    def test_low_confidence_review_queue_uses_recent_retrieval_logs(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            db_path = Path(tmp) / "db.sqlite3"
            conn = open_database(db_path)

            samples = [
                {
                    "query": "good query",
                    "confidence": 0.72,
                    "created_at": "2026-04-22T10:00:00Z",
                    "top_docs": [
                        {"doc_id": "doc-good", "title": "Good Doc"},
                    ],
                },
                {
                    "query": "beta query",
                    "confidence": 0.34,
                    "created_at": "2026-04-22T10:01:00Z",
                    "top_docs": [
                        {"doc_id": "doc-beta-1", "title": "Beta One"},
                        {"doc_id": "doc-beta-2", "title": "Beta Two"},
                        {"doc_id": "doc-beta-3", "title": "Beta Three"},
                    ],
                },
                {
                    "query": "gamma query",
                    "confidence": 0.12,
                    "created_at": "2026-04-22T10:02:00Z",
                    "top_docs": [],
                },
                {
                    "query": "delta query",
                    "confidence": 0.28,
                    "created_at": "2026-04-22T10:03:00Z",
                    "top_docs": [
                        {"doc_id": "doc-delta", "title": "Delta Doc"},
                    ],
                },
            ]
            for sample in samples:
                result = {
                    "query": sample["query"],
                    "filters": {},
                    "top_docs": sample["top_docs"],
                    "top_chunks": [],
                    "explanations": [],
                    "confidence": sample["confidence"],
                    "retrieved_at": sample["created_at"],
                }
                conn.execute(
                    "INSERT INTO retrieval_logs(query, filters_json, result_json, confidence, created_at) VALUES (?, ?, ?, ?, ?)",
                    (
                        sample["query"],
                        json.dumps({}, sort_keys=True),
                        json.dumps(result, sort_keys=True),
                        sample["confidence"],
                        sample["created_at"],
                    ),
                )
            conn.commit()

            queue = low_confidence_review_queue(conn, threshold=0.35, limit=3, top_docs_limit=2)
            health_queue = low_confidence_review_queue(conn)
            self.assertEqual(queue["threshold"], 0.35)
            self.assertEqual(queue["limit"], 3)
            self.assertEqual(queue["count"], 3)
            self.assertEqual([item["query"] for item in queue["items"]], ["delta query", "gamma query", "beta query"])
            self.assertEqual(queue["items"][0]["created_at"], "2026-04-22T10:03:00Z")
            self.assertEqual(queue["items"][0]["top_docs"], [{"doc_id": "doc-delta", "title": "Delta Doc"}])
            self.assertEqual(queue["items"][1]["top_docs"], [])
            self.assertEqual(
                queue["items"][2]["top_docs"],
                [
                    {"doc_id": "doc-beta-1", "title": "Beta One"},
                    {"doc_id": "doc-beta-2", "title": "Beta Two"},
                ],
            )

            health = health_report(conn)
            self.assertEqual(health["low_confidence_review_queue"], health_queue)

    def test_eval_suite_scores_labeled_queries(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            docs_root = root / "docs"
            runbooks_root = root / "runbooks"
            db_path = root / "db.sqlite3"
            eval_path = root / "eval.jsonl"
            docs_root.mkdir()
            runbooks_root.mkdir()
            conn = open_database(db_path)

            metadata = build_default_frontmatter(
                title="Signal Queue Backpressure",
                doc_type="incident_runbook",
                lifecycle_state="active",
                service="signal",
                feature="queue",
                provenance_source_ref=str(docs_root / "signal-queue.md"),
                retrieval_synopsis="Recover Signal queue backpressure.",
            )
            source = docs_root / "signal-queue.md"
            source.write_text(
                dump_frontmatter(metadata)
                + "# Purpose\n\nRecover Signal queue backpressure and message delivery lag.\n",
                encoding="utf-8",
            )
            index_markdown_file(conn, source, runbooks_root=runbooks_root)
            conn.commit()

            eval_path.write_text(
                "\n".join(
                    [
                        json.dumps(
                            {
                                "query_id": "q1",
                                "query": "Signal queue backpressure",
                                "expected_doc_ids": [metadata["doc_id"]],
                            },
                            sort_keys=True,
                        ),
                        json.dumps(
                            {
                                "query_id": "q2",
                                "query": "message delivery lag",
                            },
                            sort_keys=True,
                        ),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            result = eval_suite(conn, eval_set_path=eval_path, top_k=3)
            self.assertEqual(result["metrics"]["total_cases"], 2)
            self.assertEqual(result["metrics"]["labeled_cases"], 1)
            self.assertEqual(result["metrics"]["unlabeled_cases"], 1)
            self.assertEqual(result["metrics"]["recall_at_3"], 1.0)
            self.assertEqual(result["metrics"]["top1_accuracy"], 1.0)
            self.assertEqual(result["metrics"]["mrr"], 1.0)
            self.assertEqual(result["results"][0]["rank"], 1)
            self.assertIn(metadata["doc_id"], result["results"][0]["top_doc_ids"])
            log_count = conn.execute("SELECT count(*) AS count FROM retrieval_logs").fetchone()["count"]
            self.assertEqual(log_count, 0)

    def test_eval_label_queue_and_update_label(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            docs_root = root / "docs"
            runbooks_root = root / "runbooks"
            db_path = root / "db.sqlite3"
            eval_path = root / "eval.jsonl"
            docs_root.mkdir()
            runbooks_root.mkdir()
            conn = open_database(db_path)

            metadata = build_default_frontmatter(
                title="OAuth Token Lifecycle",
                doc_type="feature_runbook",
                lifecycle_state="active",
                service="oauth",
                feature="tokens",
                provenance_source_ref=str(docs_root / "oauth-token.md"),
                retrieval_synopsis="OAuth token lifecycle notes.",
            )
            source = docs_root / "oauth-token.md"
            source.write_text(
                dump_frontmatter(metadata) + "# Purpose\n\nOAuth token lifecycle and refresh behavior.\n",
                encoding="utf-8",
            )
            index_markdown_file(conn, source, runbooks_root=runbooks_root)
            conn.commit()

            eval_path.write_text(
                json.dumps(
                    {
                        "query_id": "q1",
                        "query": "oauth token lifecycle",
                    },
                    sort_keys=True,
                )
                + "\n",
                encoding="utf-8",
            )

            queue = eval_label_queue(conn, eval_set_path=eval_path, top_k=3, limit=10)
            self.assertEqual(queue["count"], 1)
            self.assertTrue(queue["items"][0]["needs_label"])
            self.assertEqual(queue["items"][0]["query_id"], "q1")
            self.assertIn(metadata["doc_id"], [doc["doc_id"] for doc in queue["items"][0]["top_docs"]])
            log_count = conn.execute("SELECT count(*) AS count FROM retrieval_logs").fetchone()["count"]
            self.assertEqual(log_count, 0)

            update = update_eval_label(
                eval_set_path=eval_path,
                query_id="q1",
                expected_doc_ids=[metadata["doc_id"]],
            )
            self.assertTrue(update["ok"])
            saved = [json.loads(line) for line in eval_path.read_text(encoding="utf-8").splitlines()]
            self.assertEqual(saved[0]["expected_doc_ids"], [metadata["doc_id"]])

            queue_after = eval_label_queue(conn, eval_set_path=eval_path, top_k=3, limit=10)
            self.assertEqual(queue_after["count"], 0)


if __name__ == "__main__":
    unittest.main()

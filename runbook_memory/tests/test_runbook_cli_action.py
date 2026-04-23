from __future__ import annotations

import argparse
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from runbook_memory.frontmatter import build_default_frontmatter, dump_frontmatter
from runbook_memory.indexer import index_markdown_file
from runbook_memory.schema import open_database
from runbook_memory.tools.runbook_cli import cmd_action


class RunbookCliActionTests(unittest.TestCase):
    def test_review_queue_includes_low_confidence_queries(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            runbooks_root = root / "runbooks"
            db_path = root / "runbook_memory.sqlite3"
            runbooks_root.mkdir()

            conn = open_database(db_path)
            result = {
                "query": "unclear routing question",
                "filters": {},
                "top_docs": [{"doc_id": "rbk_example", "title": "Example"}],
                "top_chunks": [],
                "explanations": [],
                "confidence": 0.2,
                "retrieved_at": "2026-04-22T10:00:00Z",
            }
            conn.execute(
                "INSERT INTO retrieval_logs(query, filters_json, result_json, confidence, created_at) VALUES (?, ?, ?, ?, ?)",
                (
                    "unclear routing question",
                    json.dumps({}, sort_keys=True),
                    json.dumps(result, sort_keys=True),
                    0.2,
                    "2026-04-22T10:00:00Z",
                ),
            )
            conn.commit()
            conn.close()

            payload = {
                "params": {"top_k": 5, "confidence_threshold": 0.35},
                "runtime": {
                    "repoRoot": str(root),
                    "runbooksRoot": str(runbooks_root),
                    "dbPath": str(db_path),
                    "reportsDir": str(root / "reports"),
                },
            }
            args = argparse.Namespace(config=None, payload_json=json.dumps(payload), action="review_queue")

            stdout = io.StringIO()
            with redirect_stdout(stdout):
                exit_code = cmd_action(args)

            self.assertEqual(exit_code, 0)
            payload = json.loads(stdout.getvalue())
            self.assertIn("low_confidence_queries", payload)
            low_confidence = payload["low_confidence_queries"]
            self.assertEqual(low_confidence["count"], 1)
            self.assertEqual(low_confidence["items"][0]["query"], "unclear routing question")
            self.assertEqual(
                low_confidence["items"][0]["top_docs"],
                [{"doc_id": "rbk_example", "title": "Example"}],
            )

    def test_reindex_honors_doc_ids(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            runbooks_root = root / "runbooks"
            db_path = root / "runbook_memory.sqlite3"
            source = root / "signal-routing.md"
            runbooks_root.mkdir()

            metadata = build_default_frontmatter(
                title="Signal Routing",
                doc_type="incident_runbook",
                lifecycle_state="active",
                service="signal",
                feature="routing",
                provenance_source_ref=str(source),
                retrieval_synopsis="Signal routing operator notes.",
            )
            body = "# Purpose\n\nInitial signal routing guidance.\n"
            source.write_text(dump_frontmatter(metadata) + body, encoding="utf-8")

            conn = open_database(db_path)
            index_markdown_file(conn, source, runbooks_root=runbooks_root)
            conn.commit()
            conn.close()

            updated_body = "# Purpose\n\nUpdated signal routing guidance.\n"
            source.write_text(dump_frontmatter(metadata) + updated_body, encoding="utf-8")

            payload = {
                "params": {"mode": "embeddings", "doc_ids": [metadata["doc_id"]]},
                "runtime": {
                    "repoRoot": str(root),
                    "runbooksRoot": str(runbooks_root),
                    "dbPath": str(db_path),
                    "reportsDir": str(root / "reports"),
                },
            }
            args = argparse.Namespace(config=None, payload_json=json.dumps(payload), action="reindex")

            stdout = io.StringIO()
            with redirect_stdout(stdout):
                exit_code = cmd_action(args)

            self.assertEqual(exit_code, 0)
            result = json.loads(stdout.getvalue())
            self.assertTrue(result["ok"])
            self.assertTrue(result["targeted"])
            self.assertEqual(result["mode"], "embeddings")
            self.assertEqual(result["indexed_docs"], 1)
            self.assertEqual(result["docs"][0]["doc_id"], metadata["doc_id"])

            conn = open_database(db_path)
            row = conn.execute(
                "SELECT text FROM chunks WHERE doc_id = ? ORDER BY ordinal LIMIT 1",
                (metadata["doc_id"],),
            ).fetchone()
            conn.close()
            self.assertIsNotNone(row)
            self.assertIn("Updated signal routing guidance", str(row["text"]))


if __name__ == "__main__":
    unittest.main()

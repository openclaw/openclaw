import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "dali-local-v1" / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from memory_store import append_reflection, bootstrap_workspace, search_reflections_text  # noqa: E402
from retrieval_store import build_context_bundle  # noqa: E402


class RetrievalStoreTests(unittest.TestCase):
    def _write_fixture_corpus(self, root: Path) -> Path:
        corpus_root = root / "source_research_corpus"
        (corpus_root / "03_metadata" / "records").mkdir(parents=True)
        (corpus_root / "08_indexes").mkdir(parents=True)
        (corpus_root / "09_vector-db" / "chunks").mkdir(parents=True)
        (corpus_root / "09_vector-db" / "lancedb").mkdir(parents=True)

        record = {
            "hash8": "abc12345",
            "sha256": "abc12345deadbeef",
            "title": "Memory Safe Agents",
            "topic": "agent-memory",
            "published": "2026-04-10T00:00:00Z",
            "updated": "2026-04-10T00:00:00Z",
            "arxiv_id": "2604.00001v1",
            "abstract_url": "http://arxiv.org/abs/2604.00001v1",
            "source_url": "https://arxiv.org/pdf/2604.00001v1.pdf",
            "authors": ["A. Researcher"],
            "categories": ["cs.AI"],
            "summary": "Consensus memory defenses for agents.",
            "pdf_path": "01_processed/by-topic/agent-memory/2026/abc12345__memory-safe-agents.pdf",
            "raw_pdf_path": "00_raw/arxiv/2026/agent-memory/2604.00001v1__memory-safe-agents.pdf",
            "text_path": "02_extracted/text/agent-memory/2026/abc12345__memory-safe-agents.txt",
            "markdown_path": "02_extracted/markdown/agent-memory/2026/abc12345__memory-safe-agents.md",
            "record_path": "03_metadata/records/abc12345.json",
        }
        (corpus_root / "03_metadata" / "records" / "abc12345.json").write_text(
            json.dumps(record, indent=2),
            encoding="utf-8",
        )
        (corpus_root / "08_indexes" / "document_locations.csv").write_text(
            "hash8,title,topic,arxiv_id,published,pdf_path,text_path,markdown_path,record_path\n"
            "abc12345,Memory Safe Agents,agent-memory,2604.00001v1,2026-04-10T00:00:00Z,"
            "01_processed/by-topic/agent-memory/2026/abc12345__memory-safe-agents.pdf,"
            "02_extracted/text/agent-memory/2026/abc12345__memory-safe-agents.txt,"
            "02_extracted/markdown/agent-memory/2026/abc12345__memory-safe-agents.md,"
            "03_metadata/records/abc12345.json\n",
            encoding="utf-8",
        )
        (corpus_root / "09_vector-db" / "manifest.json").write_text(
            json.dumps(
                {
                    "documents": [
                        {
                            "hash8": "abc12345",
                            "chunk_file": "09_vector-db/chunks/abc12345.jsonl",
                        }
                    ],
                    "dimension": 1024,
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        chunk_lines = [
            {
                "id": "abc12345::0",
                "chunk_index": 0,
                "text": "Consensus memory defense reduces poisoned-memory failures.",
                "title": "Memory Safe Agents",
                "topic": "agent-memory",
                "arxiv_id": "2604.00001v1",
            },
            {
                "id": "abc12345::1",
                "chunk_index": 1,
                "text": "SQLite full text search provides a canonical document substrate.",
                "title": "Memory Safe Agents",
                "topic": "agent-memory",
                "arxiv_id": "2604.00001v1",
            },
        ]
        with (corpus_root / "09_vector-db" / "chunks" / "abc12345.jsonl").open("w", encoding="utf-8") as handle:
            for line in chunk_lines:
                handle.write(json.dumps(line) + "\n")
        return corpus_root

    def test_search_reflections_text_and_build_context_bundle(self) -> None:
        from document_store import import_source_research_corpus  # noqa: E402

        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "dali-local-v1"
            bootstrap_workspace(root)
            db_path = root / "state" / "dali.sqlite3"
            corpus_root = self._write_fixture_corpus(Path(tmp_dir))
            import_source_research_corpus(db_path, corpus_root=corpus_root, refresh=True)

            append_reflection(
                db_path,
                source_event_id=None,
                reflection_text="Agent memory defense needs a canonical document substrate.",
            )

            reflection_hits = search_reflections_text(db_path, "memory defense", limit=5)
            self.assertEqual(len(reflection_hits), 1)
            self.assertGreaterEqual(reflection_hits[0]["text_score"], 2)

            bundle = build_context_bundle(
                str(db_path),
                query="memory defense",
                topic="agent-memory",
                document_limit=2,
                chunk_limit=2,
                reflection_limit=2,
                max_chars=4000,
            )

            self.assertEqual(bundle["query"], "memory defense")
            self.assertEqual(len(bundle["documents"]), 1)
            self.assertEqual(bundle["documents"][0]["hash8"], "abc12345")
            self.assertEqual(len(bundle["reflections"]), 1)
            self.assertIn("Memory Safe Agents", bundle["contextText"])
            self.assertIn("canonical document substrate", bundle["contextText"])


if __name__ == "__main__":
    unittest.main()

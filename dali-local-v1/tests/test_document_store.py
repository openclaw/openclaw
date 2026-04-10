import json
import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "dali-local-v1" / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from document_store import (  # noqa: E402
    get_document,
    import_source_research_corpus,
    list_document_chunks_for_document,
    list_document_corpora,
    list_documents,
    search_document_chunks,
)
from memory_store import bootstrap_workspace, summary  # noqa: E402


class DocumentStoreTests(unittest.TestCase):
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
                "doc_hash8": "abc12345",
                "title": "Memory Safe Agents",
                "topic": "agent-memory",
                "arxiv_id": "2604.00001v1",
                "pdf_path": record["pdf_path"],
                "text_path": record["text_path"],
                "chunk_index": 0,
                "text": "Consensus memory defense reduces poisoned-memory failures.",
                "vector": [0.1, 0.2, 0.3],
            },
            {
                "id": "abc12345::1",
                "doc_hash8": "abc12345",
                "title": "Memory Safe Agents",
                "topic": "agent-memory",
                "arxiv_id": "2604.00001v1",
                "pdf_path": record["pdf_path"],
                "text_path": record["text_path"],
                "chunk_index": 1,
                "text": "SQLite full text search provides a canonical document substrate.",
                "vector": [0.2, 0.1, 0.0],
            },
        ]
        with (corpus_root / "09_vector-db" / "chunks" / "abc12345.jsonl").open("w", encoding="utf-8") as handle:
            for line in chunk_lines:
                handle.write(json.dumps(line) + "\n")
        return corpus_root

    def test_imports_source_research_corpus_and_supports_search(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "dali-local-v1"
            bootstrap_workspace(root)
            db_path = root / "state" / "dali.sqlite3"
            corpus_root = self._write_fixture_corpus(Path(tmp_dir))

            payload = import_source_research_corpus(
                db_path,
                corpus_root=corpus_root,
                refresh=True,
            )

            self.assertEqual(payload["importedDocuments"], 1)
            self.assertEqual(payload["importedChunks"], 2)

            corpora = list_document_corpora(db_path)
            self.assertEqual(len(corpora), 1)
            self.assertEqual(corpora[0]["document_count"], 1)
            self.assertEqual(corpora[0]["chunk_count"], 2)

            documents = list_documents(db_path, topic="agent-memory")
            self.assertEqual(len(documents), 1)
            self.assertEqual(documents[0]["hash8"], "abc12345")
            self.assertEqual(documents[0]["chunk_count"], 2)

            document = get_document(db_path, hash8="abc12345")
            self.assertIsNotNone(document)
            assert document is not None
            self.assertEqual(document["title"], "Memory Safe Agents")
            self.assertEqual(document["authors"], ["A. Researcher"])

            chunks = list_document_chunks_for_document(db_path, hash8="abc12345", limit=10)
            self.assertEqual(len(chunks), 2)
            self.assertEqual(chunks[0]["chunk_index"], 0)
            self.assertIn("poisoned-memory", chunks[0]["text"])

            results = search_document_chunks(db_path, query="canonical memory defense", topic="agent-memory", limit=5)
            self.assertGreaterEqual(len(results), 1)
            self.assertEqual(results[0]["hash8"], "abc12345")
            self.assertIn("Memory Safe Agents", results[0]["title"])

            counts = summary(db_path)
            self.assertEqual(counts["document_corpora"], 1)
            self.assertEqual(counts["documents"], 1)
            self.assertEqual(counts["document_chunks"], 2)

    def test_import_tolerates_missing_chunk_file(self) -> None:
        with TemporaryDirectory() as tmp_dir:
            root = Path(tmp_dir) / "dali-local-v1"
            bootstrap_workspace(root)
            db_path = root / "state" / "dali.sqlite3"
            corpus_root = self._write_fixture_corpus(Path(tmp_dir))

            manifest_path = corpus_root / "09_vector-db" / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["documents"].append(
                {
                    "hash8": "missing01",
                    "chunk_file": "09_vector-db/chunks/missing01.jsonl",
                }
            )
            manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

            missing_record = {
                "hash8": "missing01",
                "sha256": "missing01deadbeef",
                "title": "Missing Chunks Still Import",
                "topic": "agent-memory",
                "published": "2026-04-11T00:00:00Z",
                "record_path": "03_metadata/records/missing01.json",
            }
            (corpus_root / "03_metadata" / "records" / "missing01.json").write_text(
                json.dumps(missing_record, indent=2),
                encoding="utf-8",
            )

            payload = import_source_research_corpus(db_path, corpus_root=corpus_root, refresh=True)

            self.assertEqual(payload["importedDocuments"], 2)
            self.assertEqual(payload["importedChunks"], 2)
            self.assertEqual(len(payload["missingChunkFiles"]), 1)
            self.assertTrue(payload["missingChunkFiles"][0].endswith("missing01.jsonl"))

            missing_document = get_document(db_path, hash8="missing01")
            self.assertIsNotNone(missing_document)
            assert missing_document is not None
            self.assertEqual(missing_document["chunk_count"], 0)


if __name__ == "__main__":
    unittest.main()

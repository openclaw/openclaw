from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from runbook_memory.frontmatter import build_default_frontmatter, dump_frontmatter
from runbook_memory.indexer import index_markdown_file, resolve_target_path
from runbook_memory.migration import update_changed_docs
from runbook_memory.schema import open_database


class MigrationChangedDocsTests(unittest.TestCase):
    def _seed_document(self, root: Path, source_name: str = "alpha.md") -> tuple[Path, Path, dict[str, object]]:
        docs_root = root / "docs"
        runbooks_root = root / "runbooks"
        docs_root.mkdir()
        runbooks_root.mkdir()

        source = docs_root / source_name
        metadata = build_default_frontmatter(
            title="Alpha",
            doc_type="incident_runbook",
            lifecycle_state="active",
            provenance_source_ref=str(source),
        )
        body = "# Purpose\n\nHello\n"
        source.write_text(dump_frontmatter(metadata) + body, encoding="utf-8")
        return docs_root, runbooks_root, metadata

    def test_changed_docs_updates_paths_when_file_is_renamed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            docs_root, runbooks_root, metadata = self._seed_document(root)
            db_path = root / "db.sqlite3"
            conn = open_database(db_path)

            source = docs_root / "alpha.md"
            index_markdown_file(conn, source, runbooks_root=runbooks_root)

            renamed = docs_root / "beta.md"
            source.rename(renamed)

            changed = update_changed_docs(conn, roots=[docs_root], runbooks_root=runbooks_root)
            expected_canonical = resolve_target_path(runbooks_root, metadata, renamed)
            row = conn.execute(
                "SELECT source_path, canonical_path, content_checksum FROM documents WHERE doc_id = ?",
                (metadata["doc_id"],),
            ).fetchone()

            self.assertEqual(changed, [str(renamed)])
            self.assertIsNotNone(row)
            self.assertEqual(str(row["source_path"]), str(renamed))
            self.assertEqual(str(row["canonical_path"]), str(expected_canonical))
            self.assertIsNotNone(row["content_checksum"])
            conn.close()

    def test_changed_docs_skips_unchanged_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            docs_root, runbooks_root, metadata = self._seed_document(root)
            db_path = root / "db.sqlite3"
            conn = open_database(db_path)

            source = docs_root / "alpha.md"
            index_markdown_file(conn, source, runbooks_root=runbooks_root)

            changed = update_changed_docs(conn, roots=[docs_root], runbooks_root=runbooks_root)
            row = conn.execute(
                "SELECT source_path, canonical_path, content_checksum FROM documents WHERE doc_id = ?",
                (metadata["doc_id"],),
            ).fetchone()

            self.assertEqual(changed, [])
            self.assertIsNotNone(row)
            self.assertEqual(str(row["source_path"]), str(source))
            self.assertEqual(str(row["canonical_path"]), str(resolve_target_path(runbooks_root, metadata, source)))
            self.assertIsNotNone(row["content_checksum"])
            conn.close()


if __name__ == "__main__":
    unittest.main()

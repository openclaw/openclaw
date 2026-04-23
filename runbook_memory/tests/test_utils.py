from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from runbook_memory.utils import iter_markdown_files


class UtilsTests(unittest.TestCase):
    def test_iter_markdown_files_skips_runbook_template(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            real = root / "real-runbook.md"
            template = root / "runbook_template.md"
            nested_template = root / "nested" / "runbook_template.md"
            nested_template.parent.mkdir()

            real.write_text("# Real Runbook\n", encoding="utf-8")
            template.write_text("# Template\n", encoding="utf-8")
            nested_template.write_text("# Nested Template\n", encoding="utf-8")

            self.assertEqual(list(iter_markdown_files([root])), [real])
            self.assertEqual(list(iter_markdown_files([template])), [])


if __name__ == "__main__":
    unittest.main()

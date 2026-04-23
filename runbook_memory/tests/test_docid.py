from __future__ import annotations

import unittest

from runbook_memory.docid import generate_doc_id


class DocIdTests(unittest.TestCase):
    def test_doc_id_is_stable_for_same_seed(self) -> None:
        left = generate_doc_id("incident_runbook", "Signal Calendar", "/tmp/source.md")
        right = generate_doc_id("incident_runbook", "Signal Calendar", "/tmp/source.md")
        self.assertEqual(left, right)

    def test_doc_id_changes_for_different_seed(self) -> None:
        left = generate_doc_id("incident_runbook", "Signal Calendar", "/tmp/source.md")
        right = generate_doc_id("incident_runbook", "Signal Calendar", "/tmp/other.md")
        self.assertNotEqual(left, right)


if __name__ == "__main__":
    unittest.main()

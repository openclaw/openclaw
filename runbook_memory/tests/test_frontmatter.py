from __future__ import annotations

import unittest

from runbook_memory.frontmatter import (
    ALLOWED_LIFECYCLE_STATES,
    ALLOWED_TYPES,
    FrontMatterError,
    build_default_frontmatter,
    dump_frontmatter,
    parse_frontmatter,
    validate_frontmatter,
)


class FrontMatterTests(unittest.TestCase):
    def test_frontmatter_round_trip_validates(self) -> None:
        metadata = build_default_frontmatter(
            title="Queue Backpressure",
            doc_type="incident_runbook",
            lifecycle_state="active",
            provenance_source_ref="/tmp/source.md",
            aliases=["queue-backpressure", "backpressure"],
            retrieval_synopsis="Recover queue backpressure safely.",
            retrieval_hints=["throttling", "lag"],
            retrieval_not_for=["oauth refresh"],
            retrieval_commands=["openclaw channels status --probe"],
        )
        text = dump_frontmatter(metadata) + "# Purpose\n\nTest body.\n"
        parsed = parse_frontmatter(text)
        validated = validate_frontmatter(parsed.metadata)
        self.assertEqual(validated["title"], "Queue Backpressure")
        self.assertEqual(validated["type"], "incident_runbook")
        self.assertEqual(validated["aliases"], ["queue-backpressure", "backpressure"])
        self.assertEqual(validated["retrieval"]["synopsis"], "Recover queue backpressure safely.")

    def test_invalid_lifecycle_state_fails(self) -> None:
        metadata = build_default_frontmatter(
            title="Queue Backpressure",
            doc_type="incident_runbook",
            provenance_source_ref="/tmp/source.md",
        )
        metadata["lifecycle_state"] = "broken"
        with self.assertRaises(FrontMatterError):
            validate_frontmatter(metadata)

    def test_expected_enums_are_non_empty(self) -> None:
        self.assertTrue(ALLOWED_TYPES)
        self.assertTrue(ALLOWED_LIFECYCLE_STATES)


if __name__ == "__main__":
    unittest.main()

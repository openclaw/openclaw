from __future__ import annotations

import unittest
from pathlib import Path

from connectors.gmail_media_sidecar.parser import ParseError, load_fixture

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "gmail"
RUN_ID = "test-run"


def parse_fixture(name: str):
    return load_fixture(FIXTURES / name, ingestion_run_id=RUN_ID)


class GmailMediaParserTests(unittest.TestCase):
    def test_plain_text_email(self) -> None:
        item = parse_fixture("plain_text.json")

        self.assertEqual(item.gmail_message_id, "msg_plain_001")
        self.assertEqual(item.gmail_thread_id, "thread_plain_001")
        self.assertEqual(item.rfc822_message_id, "<plain-001@example.invalid>")
        self.assertEqual(item.subject, "Plain fixture")
        self.assertEqual(item.sender.address, "reporter@example.invalid")
        self.assertEqual(item.recipients["to"][0].address, "media@example.invalid")
        self.assertEqual(item.received_at, "2024-01-01T00:00:00Z")
        self.assertIn("Label_Media", item.labels)
        self.assertIn("plain text email", item.body_plain)
        self.assertEqual([url.url for url in item.extracted_urls], ["https://example.com/story?id=1"])

    def test_html_only_email(self) -> None:
        item = parse_fixture("html_only.json")

        self.assertFalse(item.plain_text_present)
        self.assertTrue(item.html_present)
        self.assertIn("HTML Only", item.body_html_text)
        self.assertIn("Read the article", item.body_text)
        self.assertNotIn("ignore()", item.body_text)
        self.assertEqual([url.url for url in item.extracted_urls], ["https://example.com/html"])
        self.assertIn("html_attribute", item.extracted_urls[0].sources)

    def test_multipart_email_prefers_plain_text_body(self) -> None:
        item = parse_fixture("multipart.json")

        self.assertTrue(item.plain_text_present)
        self.assertTrue(item.html_present)
        self.assertEqual(item.body_text, item.body_plain)
        self.assertIn("https://example.com/plain-link", item.body_text)
        self.assertEqual(
            [url.url for url in item.extracted_urls],
            ["https://example.com/html-link", "https://example.com/plain-link"],
        )

    def test_newsletter_email_extracts_inert_links(self) -> None:
        item = parse_fixture("newsletter.json")

        self.assertIn("CATEGORY_PROMOTIONS", item.labels)
        self.assertIn("Daily Newsletter", item.body_text)
        self.assertEqual(
            [url.url for url in item.extracted_urls],
            ["https://news.example.com/a", "https://news.example.com/b"],
        )
        self.assertFalse(item.hostile_content["links_followed"])

    def test_forwarded_email_is_only_normalized_not_interpreted(self) -> None:
        item = parse_fixture("forwarded.json")

        self.assertEqual(item.subject, "Fwd: Original note")
        self.assertEqual(item.sender.address, "forwarder@example.invalid")
        self.assertIn("Forwarded message", item.body_text)
        self.assertEqual(item.hostile_content["interpretation_performed"], False)

    def test_press_release_email(self) -> None:
        item = parse_fixture("press_release.json")

        self.assertEqual(item.subject, "Press release: Fixture-first media ingestion")
        self.assertIn("FOR IMMEDIATE RELEASE", item.body_text)
        self.assertEqual([url.url for url in item.extracted_urls], ["https://press.example.com/release"])

    def test_email_with_attachment_metadata_does_not_fetch_attachment(self) -> None:
        item = parse_fixture("attachment_metadata.json")

        self.assertEqual(len(item.attachments), 1)
        attachment = item.attachments[0]
        self.assertEqual(attachment.filename, "briefing.pdf")
        self.assertEqual(attachment.mime_type, "application/pdf")
        self.assertEqual(attachment.size_bytes, 12345)
        self.assertTrue(attachment.attachment_id_present)
        self.assertFalse(attachment.fetched)
        self.assertFalse(item.hostile_content["attachments_downloaded"])

    def test_malformed_email_raises_parse_error(self) -> None:
        with self.assertRaises(ParseError):
            parse_fixture("malformed.json")

    def test_duplicate_email_has_same_dedupe_key(self) -> None:
        plain = parse_fixture("plain_text.json")
        duplicate = parse_fixture("duplicate_plain_text.json")

        self.assertEqual(plain.dedupe_key, duplicate.dedupe_key)

    def test_empty_body_email(self) -> None:
        item = parse_fixture("empty_body.json")

        self.assertFalse(item.body_available)
        self.assertEqual(item.body_chars, 0)
        self.assertEqual(item.body_text, "")
        self.assertEqual(item.extracted_urls, [])

    def test_prompt_injection_fixture_remains_source_content(self) -> None:
        item = parse_fixture("prompt_injection.json")

        self.assertIn("Ignore previous instructions", item.body_text)
        self.assertTrue(item.hostile_content["is_untrusted"])
        self.assertTrue(item.hostile_content["email_content_may_contain_instructions"])
        self.assertEqual(item.hostile_content["interpretation_performed"], False)


if __name__ == "__main__":
    unittest.main()

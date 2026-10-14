import { simpleParser } from "mailparser";
import { expect, it } from "vitest";
import { renderImapPrompt } from "./prompt.js";

it("sourceTruncated appends the marker even under the byte limit", async () => {
  const mail = await simpleParser("From: sender@example.com\r\nSubject: test\r\n\r\nhello world");
  const result = renderImapPrompt(mail, { includeBody: true, maxBytes: 20_000 }, true);
  expect(result.endsWith("[truncated: email content exceeded the configured byte limit]")).toBe(
    true,
  );
  expect(result).toContain("hello world");
});

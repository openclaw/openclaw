import { describe, expect, it } from "vitest";
import { extractMSTeamsHtmlAttachmentIds, summarizeMSTeamsHtmlAttachments } from "./html.js";

const html = (content: string) => [{ contentType: "text/html", content }];

describe("msteams HTML attachment summaries", () => {
  it("counts image sources and attachment ids", () => {
    expect(
      summarizeMSTeamsHtmlAttachments(
        html('<img src="cid:a"><img src="data:image/png;base64,AA"><attachment id="file-1">'),
      ),
    ).toMatchObject({ imgTags: 2, cidImages: 1, dataImages: 1, attachmentIds: ["file-1"] });
  });

  it("returns promptly for many unterminated image and attachment tags", () => {
    // The former tag regexes re-scanned the rest of the tag from every opening.
    const images = html(`${"<IMGS".repeat(1_000)}${'SRC="S"'.repeat(700)}`);
    const attachments = html(`${"<ATTACHMENTM".repeat(500)}${'ID="M"'.repeat(800)}`);
    const started = performance.now();
    expect(summarizeMSTeamsHtmlAttachments(images)).toMatchObject({ imgTags: 0 });
    expect(extractMSTeamsHtmlAttachmentIds(attachments)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

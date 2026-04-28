import { describe, expect, it } from "vitest";
import { parseFeishuDocumentLink, parseFeishuDocumentLinkPath } from "./document-link.js";

const VALID_TOKEN = "ABCDEFGHIJKLMNOPQRSTUV";

describe("parseFeishuDocumentLinkPath", () => {
  it("normalizes aliases and optional space prefix", () => {
    expect(parseFeishuDocumentLinkPath(`/docs/${VALID_TOKEN}`)).toEqual({
      urlKind: "doc",
      token: VALID_TOKEN,
    });
    expect(parseFeishuDocumentLinkPath(`/space/bitable/${VALID_TOKEN}`)).toEqual({
      urlKind: "bitable",
      token: VALID_TOKEN,
    });
  });
});

describe("parseFeishuDocumentLink", () => {
  it("extracts token and optional table id from supported urls", () => {
    expect(
      parseFeishuDocumentLink(`https://example.test/space/wiki/${VALID_TOKEN}?table=tbl_123`),
    ).toEqual({
      rawUrl: `https://example.test/space/wiki/${VALID_TOKEN}?table=tbl_123`,
      urlKind: "wiki",
      token: VALID_TOKEN,
      tableId: "tbl_123",
    });
  });

  it("returns null for invalid urls and unsupported tokens", () => {
    expect(parseFeishuDocumentLink("not-a-url")).toBeNull();
    expect(parseFeishuDocumentLink("https://example.test/docx/short")).toBeNull();
    expect(parseFeishuDocumentLink(`https://example.test/unknown/${VALID_TOKEN}`)).toBeNull();
  });
});

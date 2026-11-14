import { describe, expect, it } from "vitest";
import { parseCommentContentElements } from "./comment-shared.js";

const VALID_TOKEN_22 = "ABCDEFGHIJKLMNOPQRSTUV";
const VALID_TOKEN_27 = "ZsJfdxrBFo0RwuxteOLc1Ekvneb";
const link = (url: string) => ({ type: "docs_link", docs_link: { url } });

describe("parseCommentContentElements linked documents", () => {
  it.each([
    ["doc", "doc"],
    ["docs", "doc"],
    ["space/doc", "doc"],
    ["sheet", "sheet"],
    ["sheets", "sheet"],
    ["space/sheet", "sheet"],
    ["docx", "docx", VALID_TOKEN_27, "#share-Huggdiqveo5N7NxyA01ck4gLnHh"],
    ["mindnote", "mindnote"],
    ["mindnotes", "mindnote"],
    ["space/mindnote", "mindnote"],
    ["bitable", "bitable", VALID_TOKEN_22, "?table=tbl_123"],
    ["base", "base"],
    ["space/bitable", "bitable"],
    ["file", "file"],
    ["space/file", "file"],
    ["wiki", "wiki"],
    ["space/wiki", "wiki"],
  ])("%s", (pathname, kind, token = VALID_TOKEN_22, suffix = "") => {
    const host = pathname === "docx" ? "bytedance.larkoffice.com" : "example.test";
    const url = `https://${host}/${pathname}/${token}${suffix}`;
    const parsed = parseCommentContentElements({
      elements: [link(url)],
    });

    expect(
      parsed.linkedDocuments.map((linked) => [
        linked.urlKind,
        linked.resolvedObjType,
        linked.resolvedObjToken ?? linked.wikiNodeToken,
      ]),
    ).toEqual([[kind, kind === "wiki" ? undefined : kind, token]]);
  });

  it("does not resolve doc-like paths with short tokens", () => {
    const rawUrl = "https://www.baidu.com/docx/guide";
    const parsed = parseCommentContentElements({
      elements: [link(rawUrl)],
    });

    expect(parsed.plainText).toBe(rawUrl);
    expect(parsed.linkedDocuments).toEqual([]);
  });
});

describe("parseCommentContentElements", () => {
  it("keeps raw external urls in text but excludes unresolved links from structured references", () => {
    const parsed = parseCommentContentElements({
      elements: [
        link(`https://bytedance.larkoffice.com/docx/${VALID_TOKEN_27}`),
        { type: "text_run", text_run: { text: " 和 " } },
        link("https://www.baidu.com/docx/guide"),
      ],
    });

    expect(parsed.plainText).toBe(
      `https://bytedance.larkoffice.com/docx/${VALID_TOKEN_27} 和 https://www.baidu.com/docx/guide`,
    );
    expect(parsed.linkedDocuments).toEqual([
      {
        rawUrl: `https://bytedance.larkoffice.com/docx/${VALID_TOKEN_27}`,
        urlKind: "docx",
        resolvedObjType: "docx",
        resolvedObjToken: VALID_TOKEN_27,
        isCurrentDocument: false,
      },
    ]);
  });
});

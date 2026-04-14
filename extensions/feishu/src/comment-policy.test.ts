import { describe, expect, it } from "vitest";
import { buildFeishuCommentDocumentKey, resolveFeishuCommentAccess } from "./comment-policy.js";

describe("buildFeishuCommentDocumentKey", () => {
  it("builds a stable fileType:fileToken key", () => {
    expect(
      buildFeishuCommentDocumentKey({
        fileType: "docx",
        fileToken: "token_123",
      }),
    ).toBe("docx:token_123");
  });
});

describe("resolveFeishuCommentAccess", () => {
  it("defaults to enabled pairing with an empty allowlist", () => {
    expect(
      resolveFeishuCommentAccess({
        fileType: "docx",
        fileToken: "token_123",
      }),
    ).toEqual({
      enabled: true,
      policy: "pairing",
      allowFrom: [],
      documentKey: "docx:token_123",
      matchedRuleKey: undefined,
      usePairingStore: true,
    });
  });

  it("prefers exact document rules over wildcard and global rules", () => {
    expect(
      resolveFeishuCommentAccess({
        comments: {
          policy: "open",
          allowFrom: ["ou_global"],
          documents: {
            "*": {
              policy: "pairing",
              allowFrom: ["ou_wildcard"],
            },
            "docx:token_123": {
              policy: "allowlist",
              allowFrom: ["ou_exact"],
            },
          },
        },
        fileType: "docx",
        fileToken: "token_123",
      }),
    ).toEqual({
      enabled: true,
      policy: "allowlist",
      allowFrom: ["ou_exact"],
      documentKey: "docx:token_123",
      matchedRuleKey: "docx:token_123",
      usePairingStore: false,
    });
  });

  it("falls back by field when an exact rule omits allowFrom", () => {
    expect(
      resolveFeishuCommentAccess({
        comments: {
          allowFrom: ["ou_global"],
          documents: {
            "*": {
              allowFrom: ["ou_wildcard"],
            },
            "docx:token_123": {
              policy: "allowlist",
            },
          },
        },
        fileType: "docx",
        fileToken: "token_123",
      }),
    ).toEqual({
      enabled: true,
      policy: "allowlist",
      allowFrom: ["ou_wildcard"],
      documentKey: "docx:token_123",
      matchedRuleKey: "docx:token_123",
      usePairingStore: false,
    });
  });
});

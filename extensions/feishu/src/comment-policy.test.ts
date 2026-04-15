import { describe, expect, it, vi } from "vitest";
import {
  buildFeishuCommentDocumentKey,
  hasFeishuCommentDirectDocumentRule,
  hasFeishuCommentWikiDocumentRule,
  resolveFeishuCommentAccess,
  resolveFeishuCommentWikiDocumentKey,
} from "./comment-policy.js";

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
      matchedRuleSource: "document",
      matchedDocumentType: "docx",
      matchedDocumentToken: "token_123",
      wikiDocumentKey: undefined,
      wikiNodeToken: undefined,
      wikiObjectType: undefined,
      wikiObjectToken: undefined,
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
      matchedRuleSource: "document",
      matchedDocumentType: "docx",
      matchedDocumentToken: "token_123",
      wikiDocumentKey: undefined,
      wikiNodeToken: undefined,
      wikiObjectType: undefined,
      wikiObjectToken: undefined,
      usePairingStore: false,
    });
  });

  it("reports wiki matches as document-level matches", () => {
    expect(
      resolveFeishuCommentAccess({
        comments: {
          documents: {
            "wiki:node_123": {
              policy: "open",
            },
          },
        },
        fileType: "docx",
        fileToken: "obj_123",
        matchedDocumentKey: "wiki:node_123",
        wikiNodeToken: "node_123",
        wikiObjectType: "docx",
        wikiObjectToken: "obj_123",
      }),
    ).toEqual({
      enabled: true,
      policy: "open",
      allowFrom: [],
      documentKey: "docx:obj_123",
      matchedRuleKey: "wiki:node_123",
      matchedRuleSource: "wiki",
      matchedDocumentType: "wiki",
      matchedDocumentToken: "node_123",
      wikiDocumentKey: "wiki:node_123",
      wikiNodeToken: "node_123",
      wikiObjectType: "docx",
      wikiObjectToken: "obj_123",
      usePairingStore: false,
    });
  });
});

describe("comment document rule helpers", () => {
  it("detects direct document rules", () => {
    expect(
      hasFeishuCommentDirectDocumentRule({
        comments: {
          documents: {
            "docx:token_123": {
              policy: "open",
            },
          },
        },
        fileType: "docx",
        fileToken: "token_123",
      }),
    ).toBe(true);
  });

  it("detects whether wiki rules are configured", () => {
    expect(
      hasFeishuCommentWikiDocumentRule({
        documents: {
          "wiki:node_123": {
            policy: "open",
          },
        },
      }),
    ).toBe(true);
  });

  it("resolves wiki node token to a wiki document key", async () => {
    const client = {
      request: vi.fn(async () => ({
        code: 0,
        data: {
          node: {
            node_token: "node_123",
            obj_type: "docx",
            obj_token: "obj_123",
          },
        },
      })),
    };

    await expect(
      resolveFeishuCommentWikiDocumentKey({
        client,
        comments: {
          documents: {
            "wiki:node_123": {
              policy: "open",
            },
          },
        },
        fileType: "docx",
        fileToken: "obj_123",
        accountId: "default",
      }),
    ).resolves.toEqual({
      documentKey: "wiki:node_123",
      wikiNodeToken: "node_123",
      objectType: "docx",
      objectToken: "obj_123",
    });
  });

  it("ignores non-wiki documents during wiki lookup fallback", async () => {
    const client = {
      request: vi.fn(async () => ({
        code: 131005,
        msg: "not found: document is not in wiki",
      })),
    };

    await expect(
      resolveFeishuCommentWikiDocumentKey({
        client,
        comments: {
          documents: {
            "wiki:node_123": {
              policy: "open",
            },
          },
        },
        fileType: "docx",
        fileToken: "obj_123",
        accountId: "default",
      }),
    ).resolves.toBeUndefined();
  });

  it("falls back when wiki lookup throws", async () => {
    const logger = vi.fn();
    const client = {
      request: vi.fn(async () => {
        throw new Error("request timeout");
      }),
    };

    await expect(
      resolveFeishuCommentWikiDocumentKey({
        client,
        comments: {
          documents: {
            "wiki:node_123": {
              policy: "open",
            },
          },
        },
        fileType: "docx",
        fileToken: "obj_123",
        accountId: "default",
        logger,
      }),
    ).resolves.toBeUndefined();
    expect(logger).toHaveBeenCalledWith(expect.stringContaining("wiki document rule lookup threw"));
  });
});

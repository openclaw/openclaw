import { describe, expect, it } from "vitest";
import {
  buildMediaLinkFallbackText,
  isAuthScopeUploadFailure,
  isRemoteHttpMediaUrl,
} from "./media-upload-fallback.js";

describe("media upload fallback predicates (#89430)", () => {
  describe("isAuthScopeUploadFailure", () => {
    it("matches the chat.bot insufficient-scope 403 from the upload endpoint", () => {
      expect(
        isAuthScopeUploadFailure(
          new Error(
            'Google Chat upload 403: {"error":{"status":"PERMISSION_DENIED","message":"Request had insufficient authentication scopes.","details":[{"reason":"ACCESS_TOKEN_SCOPE_INSUFFICIENT"}]}}',
          ),
        ),
      ).toBe(true);
      // The reason code alone (without the human message) also qualifies.
      expect(
        isAuthScopeUploadFailure(
          new Error("Google Chat upload 403: ACCESS_TOKEN_SCOPE_INSUFFICIENT"),
        ),
      ).toBe(true);
    });

    it("does NOT match a non-scope 403 — quota, not-a-member, or generic PERMISSION_DENIED", () => {
      // Real upload denials a text link cannot fix: they must surface unchanged, not degrade.
      expect(
        isAuthScopeUploadFailure(
          new Error("Google Chat upload 403: RESOURCE_EXHAUSTED Quota exceeded"),
        ),
      ).toBe(false);
      expect(
        isAuthScopeUploadFailure(
          new Error(
            'Google Chat upload 403: {"error":{"status":"PERMISSION_DENIED","message":"The caller does not have permission"}}',
          ),
        ),
      ).toBe(false);
      expect(isAuthScopeUploadFailure(new Error("Google Chat upload 403: Forbidden"))).toBe(false);
    });

    it("does NOT match non-403 upload errors — size, network, malformed", () => {
      expect(isAuthScopeUploadFailure(new Error("Google Chat upload 500: internal error"))).toBe(
        false,
      );
      expect(
        isAuthScopeUploadFailure(new Error("Google Chat media exceeds max bytes (20971520)")),
      ).toBe(false);
      expect(isAuthScopeUploadFailure(new Error("fetch failed"))).toBe(false);
    });

    it("handles non-Error inputs without throwing", () => {
      expect(isAuthScopeUploadFailure(undefined)).toBe(false);
      expect(isAuthScopeUploadFailure(null)).toBe(false);
      expect(isAuthScopeUploadFailure("Request had insufficient authentication scopes")).toBe(true);
    });
  });

  describe("isRemoteHttpMediaUrl", () => {
    it("accepts http(s) URLs and rejects local paths, file:// and data URIs", () => {
      expect(isRemoteHttpMediaUrl("https://example.com/a.png")).toBe(true);
      expect(isRemoteHttpMediaUrl("http://example.com/a.png")).toBe(true);
      expect(isRemoteHttpMediaUrl("/tmp/a.png")).toBe(false);
      expect(isRemoteHttpMediaUrl("file:///tmp/a.png")).toBe(false);
      expect(isRemoteHttpMediaUrl("data:image/png;base64,AAAA")).toBe(false);
      expect(isRemoteHttpMediaUrl(undefined)).toBe(false);
      expect(isRemoteHttpMediaUrl(null)).toBe(false);
    });
  });

  describe("buildMediaLinkFallbackText", () => {
    it("appends the URL to a caption, or returns the URL alone when the caption is empty", () => {
      expect(buildMediaLinkFallbackText("here you go", "https://x/a.png")).toBe(
        "here you go\nhttps://x/a.png",
      );
      expect(buildMediaLinkFallbackText("   ", "https://x/a.png")).toBe("https://x/a.png");
      expect(buildMediaLinkFallbackText(undefined, "https://x/a.png")).toBe("https://x/a.png");
    });
  });
});

/**
 * Tests for credential scanning in the sleep cycle.
 *
 * Verifies that CREDENTIAL_PATTERNS and detectCredential() correctly
 * identify credential-like content in memory text while not flagging
 * clean text.
 */

import { describe, it, expect } from "vitest";
import { CREDENTIAL_PATTERNS, detectCredential } from "./sleep-cycle.js";

describe("Credential Detection", () => {
  // --------------------------------------------------------------------------
  // detectCredential() — should flag dangerous content
  // --------------------------------------------------------------------------

  describe("should detect credentials", () => {
    it("detects API keys (sk-...)", () => {
      const result = detectCredential("Use the key sk-abc123def456ghi789jkl012mno345");
      expect(result).toBe("API key");
    });

    it("detects api_key patterns", () => {
      const result = detectCredential("Set api_key_live_abcdef1234567890abcdef");
      expect(result).toBe("API key");
    });

    it("detects Bearer tokens", () => {
      const result = detectCredential(
        "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature",
      );
      // Could match either Bearer token or JWT — both are valid detections
      expect(result).not.toBeNull();
    });

    it("detects password assignments (password: X)", () => {
      const result = detectCredential("The database password: myS3cretP@ss!");
      expect(result).toBe("Password assignment");
    });

    it("detects password assignments (password=X)", () => {
      const result = detectCredential("config has password=hunter2 in it");
      expect(result).toBe("Password assignment");
    });

    it("detects the missed pattern: login with X creds user/pass", () => {
      const result = detectCredential("login with radarr creds hullah/fuckbar");
      expect(result).toBe("Credentials (user/pass)");
    });

    it("detects creds user/pass without login prefix", () => {
      const result = detectCredential("use creds admin/password123 for the server");
      expect(result).toBe("Credentials (user/pass)");
    });

    it("detects URL-embedded credentials", () => {
      const result = detectCredential("Connect to https://admin:secretpass@db.example.com/mydb");
      expect(result).toBe("URL credentials");
    });

    it("detects URL credentials with http://", () => {
      const result = detectCredential("http://user:pass@192.168.1.1:8080/api");
      expect(result).toBe("URL credentials");
    });

    it("detects private keys", () => {
      const result = detectCredential("-----BEGIN RSA PRIVATE KEY-----\nMIIEow...");
      expect(result).toBe("Private key");
    });

    it("detects AWS access keys", () => {
      const result = detectCredential("AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE");
      expect(result).toBe("AWS key");
    });

    it("detects GitHub personal access tokens", () => {
      const result = detectCredential("Set GITHUB_TOKEN=ghp_ABCDEFabcdef1234567890");
      expect(result).toBe("GitHub/GitLab token");
    });

    it("detects GitLab tokens", () => {
      const result = detectCredential("Use glpat-xxxxxxxxxxxxxxxxxxxx for auth");
      expect(result).toBe("GitHub/GitLab token");
    });

    it("detects JWT tokens", () => {
      const result = detectCredential(
        "Token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
      );
      expect(result).toBe("JWT");
    });

    it("detects token=value patterns", () => {
      const result = detectCredential(
        "Set token=abcdef1234567890abcdef1234567890ab for authentication",
      );
      expect(result).toBe("Token/secret");
    });

    it("detects secret: value patterns", () => {
      const result = detectCredential(
        "The client secret: abcdef1234567890abcdef1234567890abcdef12",
      );
      expect(result).toBe("Token/secret");
    });
  });

  // --------------------------------------------------------------------------
  // detectCredential() — should NOT flag clean text
  // --------------------------------------------------------------------------

  describe("should not flag clean text", () => {
    it("does not flag normal text", () => {
      expect(detectCredential("Remember to buy groceries tomorrow")).toBeNull();
    });

    it("does not flag password advice (without actual password)", () => {
      expect(
        detectCredential("Make sure the password is at least 8 characters long for security"),
      ).toBeNull();
    });

    it("does not flag discussion about tokens", () => {
      expect(detectCredential("We should use JWT tokens for authentication")).toBeNull();
    });

    it("does not flag short key-like words", () => {
      expect(detectCredential("The key to success is persistence")).toBeNull();
    });

    it("does not flag URLs without credentials", () => {
      expect(detectCredential("Visit https://example.com/api/v1 for docs")).toBeNull();
    });

    it("does not flag discussion about API key rotation", () => {
      expect(detectCredential("Rotate your API keys every 90 days as a best practice")).toBeNull();
    });

    it("does not flag file paths", () => {
      expect(detectCredential("Credentials are stored in /home/user/.secrets/api.json")).toBeNull();
    });

    it("does not flag casual use of slash in text", () => {
      expect(detectCredential("Use the read/write mode for better performance")).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // CREDENTIAL_PATTERNS — structural checks
  // --------------------------------------------------------------------------

  describe("CREDENTIAL_PATTERNS structure", () => {
    it("has at least 8 patterns", () => {
      expect(CREDENTIAL_PATTERNS.length).toBeGreaterThanOrEqual(8);
    });

    it("each pattern has a label and valid RegExp", () => {
      for (const { pattern, label } of CREDENTIAL_PATTERNS) {
        expect(pattern).toBeInstanceOf(RegExp);
        expect(label).toBeTruthy();
        expect(typeof label).toBe("string");
      }
    });
  });
});

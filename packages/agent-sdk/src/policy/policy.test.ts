// @openclaw/agent-sdk — Unit tests for PR 2: secrets + network policy.

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";

const PKG_DIST = resolve(import.meta.dirname, "..", "..", "dist");
const TMP = resolve(import.meta.dirname, "..", "__fixtures__", "tmp");

// ── Secret resolution ───────────────────────────────────────────────

describe("secrets", () => {
  const envKey = "OPENCLAW_TEST_SECRET_PR2";

  afterEach(() => {
    delete process.env[envKey];
  });

  describe("resolveSecret", () => {
    it("resolves an env source", async () => {
      process.env[envKey] = "supersecret";
      const { resolveSecret } = await import(`${PKG_DIST}/policy/secrets.mjs`);
      const result = resolveSecret({ source: "env", key: envKey });
      expect(result.value).toBe("supersecret");
      expect(result.error).toBeUndefined();
    });

    it("fails closed when env var is missing", async () => {
      const { resolveSecret } = await import(`${PKG_DIST}/policy/secrets.mjs`);
      const result = resolveSecret({ source: "env", key: "NONEXISTENT_VAR_12345" });
      expect(result.value).toBeUndefined();
      expect(result.error).toContain("not set");
    });

    it("fails closed when env var is empty string", async () => {
      process.env[envKey] = "";
      const { resolveSecret } = await import(`${PKG_DIST}/policy/secrets.mjs`);
      const result = resolveSecret({ source: "env", key: envKey });
      expect(result.value).toBeUndefined();
      expect(result.error).toContain("not set");
    });

    it("fails closed for gateway source in standalone context", async () => {
      const { resolveSecret } = await import(`${PKG_DIST}/policy/secrets.mjs`);
      const result = resolveSecret({ source: "gateway", ref: "secrets.myKey" });
      expect(result.value).toBeUndefined();
      expect(result.error).toContain("gateway secret resolution not available");
    });

    it("resolves a file source", async () => {
      if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
      writeFileSync(resolve(TMP, "test-secret.txt"), "file-secret-value\n", "utf8");
      const { resolveSecret } = await import(`${PKG_DIST}/policy/secrets.mjs`);
      const result = resolveSecret({ source: "file", path: "test-secret.txt" }, TMP);
      expect(result.value).toBe("file-secret-value");
      expect(result.error).toBeUndefined();
    });

    it("fails closed when file not found", async () => {
      const { resolveSecret } = await import(`${PKG_DIST}/policy/secrets.mjs`);
      const result = resolveSecret({ source: "file", path: "nonexistent.txt" }, TMP);
      expect(result.value).toBeUndefined();
      expect(result.error).toContain("not found");
    });

    it("fails closed when file is empty", async () => {
      if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
      writeFileSync(resolve(TMP, "empty-secret.txt"), "   \n", "utf8");
      const { resolveSecret } = await import(`${PKG_DIST}/policy/secrets.mjs`);
      const result = resolveSecret({ source: "file", path: "empty-secret.txt" }, TMP);
      expect(result.value).toBeUndefined();
      expect(result.error).toContain("empty");
    });
  });
});

// ── Network policy ──────────────────────────────────────────────────

describe("network policy", () => {
  describe("checkNetworkEgress", () => {
    it("denies all when egress=none", async () => {
      const { checkNetworkEgress } = await import(`${PKG_DIST}/policy/network.mjs`);
      const result = checkNetworkEgress("example.com", { egress: "none" });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("disabled");
    });

    it("allows domain in allowed list", async () => {
      const { checkNetworkEgress } = await import(`${PKG_DIST}/policy/network.mjs`);
      const result = checkNetworkEgress("api.example.com", {
        egress: "full",
        allowedDomains: ["api.example.com"],
      });
      expect(result.allowed).toBe(true);
    });

    it("denies domain not in allowed list", async () => {
      const { checkNetworkEgress } = await import(`${PKG_DIST}/policy/network.mjs`);
      const result = checkNetworkEgress("evil.com", {
        egress: "full",
        allowedDomains: ["api.example.com"],
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("not in allowed list");
    });

    it("denied domains take precedence over allowed", async () => {
      const { checkNetworkEgress } = await import(`${PKG_DIST}/policy/network.mjs`);
      const result = checkNetworkEgress("example.com", {
        egress: "full",
        allowedDomains: ["example.com"],
        deniedDomains: ["example.com"],
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("denied");
    });

    it("supports wildcard denied domains", async () => {
      const { checkNetworkEgress } = await import(`${PKG_DIST}/policy/network.mjs`);
      const result = checkNetworkEgress("sub.evil.com", {
        egress: "full",
        deniedDomains: ["*.evil.com"],
      });
      expect(result.allowed).toBe(false);
    });

    it("supports wildcard allowed domains", async () => {
      const { checkNetworkEgress } = await import(`${PKG_DIST}/policy/network.mjs`);
      const result = checkNetworkEgress("api.example.com", {
        egress: "restricted",
        allowedDomains: ["*.example.com"],
      });
      expect(result.allowed).toBe(true);
    });

    it("denies in restricted mode with no allowed list", async () => {
      const { checkNetworkEgress } = await import(`${PKG_DIST}/policy/network.mjs`);
      const result = checkNetworkEgress("example.com", { egress: "restricted" });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("restricted");
    });

    it("allows in full mode with no allowed list and not denied", async () => {
      const { checkNetworkEgress } = await import(`${PKG_DIST}/policy/network.mjs`);
      const result = checkNetworkEgress("example.com", { egress: "full" });
      expect(result.allowed).toBe(true);
    });

    it("wildcard denied matches parent domain too", async () => {
      const { checkNetworkEgress } = await import(`${PKG_DIST}/policy/network.mjs`);
      const policy = { egress: "full" as const, deniedDomains: ["*.evil.com"] };
      expect(checkNetworkEgress("sub.evil.com", policy).allowed).toBe(false);
      expect(checkNetworkEgress("evil.com", policy).allowed).toBe(false);
    });
  });

  describe("isPrivateIp", () => {
    const cases: [string, boolean, string?][] = [
      ["10.0.0.1", true, "private"],
      ["10.255.255.255", true, "private"],
      ["172.16.0.1", true, "private"],
      ["172.31.255.255", true, "private"],
      ["172.15.0.1", false],
      ["172.32.0.1", false],
      ["192.168.0.1", true, "private"],
      ["192.168.1.1", true, "private"],
      ["127.0.0.1", true, "loopback"],
      ["127.255.255.255", true, "loopback"],
      ["::1", true, "loopback"],
      ["fd00::1", true, "uniqueLocal"],
      ["fd12:3456:789a::1", true, "uniqueLocal"],
      ["8.8.8.8", false],
      ["1.1.1.1", false],
      ["100.64.0.1", true, "carrierGradeNat"],
      ["2001:db8::1", true, "reserved"],
      ["2607:f8b0:4004:800::200e", false],
    ];

    for (const [ip, expected, range] of cases) {
      it(`${ip} is ${expected ? "private" : "public"}`, async () => {
        const { isPrivateIp } = await import(`${PKG_DIST}/policy/network.mjs`);
        const result = isPrivateIp(ip);
        expect(result.isPrivate).toBe(expected);
        if (range) expect(result.matchedRange).toBe(range);
      });
    }
  });

  describe("checkDnsRebinding", () => {
    it("allows clean domain + public IP", async () => {
      const { checkDnsRebinding } = await import(`${PKG_DIST}/policy/network.mjs`);
      const result = checkDnsRebinding("example.com", "93.184.216.34", { egress: "full" });
      expect(result.allowed).toBe(true);
    });

    it("blocks domain resolving to private IP", async () => {
      const { checkDnsRebinding } = await import(`${PKG_DIST}/policy/network.mjs`);
      const result = checkDnsRebinding("attacker.com", "192.168.1.1", { egress: "full" });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("DNS rebinding");
    });

    it("blocks domain resolving to 127.0.0.1", async () => {
      const { checkDnsRebinding } = await import(`${PKG_DIST}/policy/network.mjs`);
      const result = checkDnsRebinding("evil.com", "127.0.0.1", { egress: "full" });
      expect(result.allowed).toBe(false);
    });

    it("blocks domain resolving to 10.x.x.x", async () => {
      const { checkDnsRebinding } = await import(`${PKG_DIST}/policy/network.mjs`);
      const result = checkDnsRebinding("evil.com", "10.0.0.1", { egress: "full" });
      expect(result.allowed).toBe(false);
    });

    it("skips IP check when denyPrivateRanges is false", async () => {
      const { checkDnsRebinding } = await import(`${PKG_DIST}/policy/network.mjs`);
      const result = checkDnsRebinding("any.com", "192.168.1.1", {
        egress: "full",
        denyPrivateRanges: false,
      });
      expect(result.allowed).toBe(true);
    });

    it("still blocks denied domains with public IP", async () => {
      const { checkDnsRebinding } = await import(`${PKG_DIST}/policy/network.mjs`);
      const result = checkDnsRebinding("evil.com", "93.184.216.34", {
        egress: "full",
        deniedDomains: ["evil.com"],
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain("denied");
    });
  });
});

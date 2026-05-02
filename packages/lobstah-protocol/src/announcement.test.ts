import { describe, expect, it } from "vitest";
import {
  ANNOUNCEMENT_MAX_SKEW_MS,
  type Announcement,
  announcementStatus,
  formatPubkey,
  generateIdentity,
  signAnnouncement,
  verifyAnnouncement,
} from "./index.js";

const sample = (pubkey: string, overrides: Partial<Announcement> = {}): Announcement => ({
  version: 1,
  pubkey,
  url: "http://example.com:17474",
  label: "test",
  models: ["llama3.1:8b"],
  ttlSeconds: 300,
  announcedAt: 1_000_000,
  ...overrides,
});

describe("announcement signing", () => {
  it("round-trips sign + verify", () => {
    const id = generateIdentity();
    const a = sample(formatPubkey(id.publicKey));
    const signed = signAnnouncement(a, id.secretKey);
    expect(verifyAnnouncement(signed)).toBe(true);
  });

  it("detects tampering of url", () => {
    const id = generateIdentity();
    const a = sample(formatPubkey(id.publicKey));
    const signed = signAnnouncement(a, id.secretKey);
    const tampered = {
      ...signed,
      announcement: { ...signed.announcement, url: "http://attacker.example" },
    };
    expect(verifyAnnouncement(tampered)).toBe(false);
  });

  it("detects tampering of models list", () => {
    const id = generateIdentity();
    const a = sample(formatPubkey(id.publicKey));
    const signed = signAnnouncement(a, id.secretKey);
    const tampered = {
      ...signed,
      announcement: { ...signed.announcement, models: ["fake-model"] },
    };
    expect(verifyAnnouncement(tampered)).toBe(false);
  });

  it("rejects signatures from a different key", () => {
    const id = generateIdentity();
    const other = generateIdentity();
    const a = sample(formatPubkey(id.publicKey));
    const signed = signAnnouncement(a, other.secretKey);
    expect(verifyAnnouncement(signed)).toBe(false);
  });
});

describe("announcementStatus", () => {
  it("ok inside the TTL", () => {
    const a = sample("lob1a", { announcedAt: 1_000_000, ttlSeconds: 60 });
    expect(announcementStatus(a, 1_000_000 + 30_000)).toBe("ok");
  });

  it("stale past the TTL", () => {
    const a = sample("lob1a", { announcedAt: 1_000_000, ttlSeconds: 60 });
    expect(announcementStatus(a, 1_000_000 + 61_000)).toBe("stale");
  });

  it("future when timestamp is too far ahead", () => {
    const a = sample("lob1a", {
      announcedAt: 1_000_000 + ANNOUNCEMENT_MAX_SKEW_MS + 1_000,
      ttlSeconds: 60,
    });
    expect(announcementStatus(a, 1_000_000)).toBe("future");
  });

  it("ok when slightly ahead within skew window", () => {
    const a = sample("lob1a", { announcedAt: 1_001_000, ttlSeconds: 60 });
    expect(announcementStatus(a, 1_000_000)).toBe("ok");
  });
});

import {
  type Announcement,
  formatPubkey,
  generateIdentity,
  signAnnouncement,
} from "@lobstah/protocol";
import { describe, expect, it } from "vitest";
import { TrackerRegistry } from "./registry.js";

const makeAnnouncement = (pubkey: string, overrides: Partial<Announcement> = {}): Announcement => ({
  version: 1,
  pubkey,
  url: "http://example.com:17474",
  label: "test",
  models: ["llama3.1:8b"],
  ttlSeconds: 300,
  announcedAt: Date.now(),
  ...overrides,
});

describe("TrackerRegistry", () => {
  it("ingests a valid announcement", () => {
    const r = new TrackerRegistry();
    const id = generateIdentity();
    const a = makeAnnouncement(formatPubkey(id.publicKey));
    const signed = signAnnouncement(a, id.secretKey);
    expect(r.ingest(signed)).toBe("ok");
    expect(r.size()).toBe(1);
  });

  it("rejects bad signatures", () => {
    const r = new TrackerRegistry();
    const id = generateIdentity();
    const other = generateIdentity();
    const a = makeAnnouncement(formatPubkey(id.publicKey));
    const signed = signAnnouncement(a, other.secretKey);
    expect(r.ingest(signed)).toBe("bad-signature");
    expect(r.size()).toBe(0);
  });

  it("rejects stale announcements", () => {
    const r = new TrackerRegistry();
    const id = generateIdentity();
    const a = makeAnnouncement(formatPubkey(id.publicKey), {
      announcedAt: Date.now() - 600_000,
      ttlSeconds: 60,
    });
    const signed = signAnnouncement(a, id.secretKey);
    expect(r.ingest(signed)).toBe("stale");
    expect(r.size()).toBe(0);
  });

  it("rejects far-future announcements (skew defense)", () => {
    const r = new TrackerRegistry();
    const id = generateIdentity();
    const a = makeAnnouncement(formatPubkey(id.publicKey), {
      announcedAt: Date.now() + 600_000,
    });
    const signed = signAnnouncement(a, id.secretKey);
    expect(r.ingest(signed)).toBe("future");
    expect(r.size()).toBe(0);
  });

  it("re-announce updates the entry, doesn't add a duplicate", () => {
    const r = new TrackerRegistry();
    const id = generateIdentity();
    const pk = formatPubkey(id.publicKey);
    const first = signAnnouncement(makeAnnouncement(pk), id.secretKey);
    const second = signAnnouncement(
      makeAnnouncement(pk, { url: "http://other.example:17474" }),
      id.secretKey,
    );
    r.ingest(first);
    r.ingest(second);
    expect(r.size()).toBe(1);
    expect(r.liveAnnouncements()[0].announcement.url).toBe("http://other.example:17474");
  });

  it("liveAnnouncements evicts stale entries on read", () => {
    const r = new TrackerRegistry();
    const id = generateIdentity();
    const a = makeAnnouncement(formatPubkey(id.publicKey), {
      announcedAt: Date.now(),
      ttlSeconds: 1,
    });
    r.ingest(signAnnouncement(a, id.secretKey));
    expect(r.size()).toBe(1);
    expect(r.liveAnnouncements(Date.now() + 2_000).length).toBe(0);
    expect(r.size()).toBe(0);
  });

  it("remove drops the entry", () => {
    const r = new TrackerRegistry();
    const id = generateIdentity();
    const pk = formatPubkey(id.publicKey);
    r.ingest(signAnnouncement(makeAnnouncement(pk), id.secretKey));
    expect(r.remove(pk)).toBe(true);
    expect(r.size()).toBe(0);
    expect(r.remove(pk)).toBe(false);
  });

  it("aggregates multiple peers", () => {
    const r = new TrackerRegistry();
    for (let i = 0; i < 3; i++) {
      const id = generateIdentity();
      r.ingest(signAnnouncement(makeAnnouncement(formatPubkey(id.publicKey)), id.secretKey));
    }
    expect(r.size()).toBe(3);
    expect(r.liveAnnouncements().length).toBe(3);
  });
});

import { type SignedAnnouncement, announcementStatus, verifyAnnouncement } from "@lobstah/protocol";

export type IngestResult = "ok" | "bad-signature" | "stale" | "future";

type Entry = {
  signed: SignedAnnouncement;
  receivedAt: number;
};

export class TrackerRegistry {
  private peers = new Map<string, Entry>();

  ingest(signed: SignedAnnouncement, now: number = Date.now()): IngestResult {
    if (!verifyAnnouncement(signed)) return "bad-signature";
    const status = announcementStatus(signed.announcement, now);
    if (status !== "ok") return status;
    this.peers.set(signed.announcement.pubkey, { signed, receivedAt: now });
    return "ok";
  }

  remove(pubkey: string): boolean {
    return this.peers.delete(pubkey);
  }

  liveAnnouncements(now: number = Date.now()): SignedAnnouncement[] {
    const out: SignedAnnouncement[] = [];
    for (const [pubkey, entry] of this.peers) {
      const status = announcementStatus(entry.signed.announcement, now);
      if (status !== "ok") {
        this.peers.delete(pubkey);
        continue;
      }
      out.push(entry.signed);
    }
    return out;
  }

  size(): number {
    return this.peers.size;
  }

  reset(): void {
    this.peers.clear();
  }
}

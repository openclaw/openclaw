import type { PresenceEntry } from "./schema/snapshot.js";

/** Opt-in `presence` payloads. Keys are opaque roster identities, parallel to full rows. */
export type PresenceReset = {
  reset: true;
  version: number;
  presence: PresenceEntry[];
  keys: string[];
};

export type PresenceDelta = {
  base: number;
  version: number;
  upsert: Array<
    | { key: string; presence: PresenceEntry }
    | { key: string; set: Partial<PresenceEntry>; unset: string[] }
  >;
  remove: string[];
  /** Complete resulting roster order, including unchanged rows. */
  order: string[];
};

export type PresenceUpdate = PresenceReset | PresenceDelta;

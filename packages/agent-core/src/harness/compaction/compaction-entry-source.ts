import type { SessionTreeEntry } from "../types.js";

/** Stable indexed transcript snapshot; callers need not retain hydrated payloads. */
export interface CompactionEntrySource {
  readonly length: number;
  /**
   * Payload-free navigation preserves entry identity, message roles, exclusions and
   * tool occurrence facts. Custom message classification may still require get().
   */
  metadata(index: number): SessionTreeEntry | undefined;
  /** Repeated reads must return the same entry data; identity is not required. */
  get(index: number): SessionTreeEntry | undefined;
}

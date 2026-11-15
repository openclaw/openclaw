// Dependency-free scan primitives shared by vault scanning and file publication.
import { createHash } from "node:crypto";

/** Runaway guard, not a size budget: a partition this large is a pathological
 * tree (e.g. a misplaced checkout), not ordinary growth. */
export const MAX_ENTRIES = 100_000;
/** Hex SHA-256 of a string. */
export const digest = (s: string) => createHash("sha256").update(s).digest("hex");

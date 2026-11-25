import { randomBytes } from "node:crypto";
import { isProcessSessionIdTaken } from "./bash-process-registry.js";
import { createSessionSlug } from "./session-slug.js";

// An opaque boot suffix prevents an old transcript handle from selecting a new process.
const bootId = randomBytes(6).toString("hex");

export function createProcessSessionId(): string {
  return `${createSessionSlug((slug) => isProcessSessionIdTaken(`${slug}:${bootId}`))}:${bootId}`;
}

export function missingProcessMessage(id: string): string {
  const bootSuffix = /:([a-f0-9]{12})$/.exec(id)?.[1];
  if (!bootSuffix) {
    // A readable slug is not a lookup key; point at the tracked ID instead of
    // implying a restart or recommending a rerun.
    return `Process ${id} is not a tracked session ID. Session IDs include a boot suffix; run process list to see tracked IDs.`;
  }
  if (bootSuffix !== bootId) {
    return `Process ${id} was started before the Gateway restarted and is no longer tracked; rerun it if still needed. Check saved output and side effects before repeating work.`;
  }
  // A current-boot handle can still be missing after removal or expiry.
  return `Process ${id} is no longer tracked or is outside this session's scope. Rerun it if still needed after checking saved output and side effects.`;
}

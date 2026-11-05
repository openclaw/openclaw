import { randomBytes } from "node:crypto";
import { isProcessSessionIdTaken } from "./bash-process-registry.js";
import { createSessionSlug } from "./session-slug.js";

// An opaque boot suffix prevents an old transcript handle from selecting a new process.
const bootId = randomBytes(6).toString("hex");

export function createProcessSessionId(): string {
  return `${createSessionSlug((slug) => isProcessSessionIdTaken(`${slug}:${bootId}`))}:${bootId}`;
}

export function missingProcessMessage(id: string): string {
  const previousBoot = /:([a-f0-9]{12})$/.exec(id)?.[1];
  if (previousBoot && previousBoot !== bootId) {
    return `Process ${id} was started before the Gateway restarted and is no longer tracked; rerun it if still needed. Check saved output and side effects before repeating work.`;
  }
  // Older handles have no boot identity, and retained results can also expire or be removed.
  return `Process ${id} is no longer tracked or is outside this session's scope. Handles are lost when the Gateway restarts; rerun it if still needed after checking saved output and side effects.`;
}

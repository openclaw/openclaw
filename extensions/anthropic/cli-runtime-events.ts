import { once } from "node:events";
import type { PassThrough } from "node:stream";

/** Keep turn event delivery ordered when the host stops reading temporarily. */
export async function writeTurnEvent(
  turn: { events: PassThrough; controller: AbortController },
  message: Record<string, unknown>,
) {
  if (!turn.events.write(message)) {
    await once(turn.events, "drain", { signal: turn.controller.signal });
  }
}

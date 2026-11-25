import { finalizeEvent, SimplePool } from "nostr-tools";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { withTimeout } from "openclaw/plugin-sdk/time-runtime";
import type { NostrProfile } from "./config-schema.js";
import { profileToContent } from "./nostr-profile-core.js";

export type ProfilePublishResult = Awaited<ReturnType<typeof publishProfile>>;

const RELAY_PUBLISH_TIMEOUT_MS = 5000;

/** Publish one signed kind:0 event, reporting each relay's result without retrying. */
export async function publishProfile(
  pool: SimplePool,
  sk: Uint8Array,
  relays: string[],
  profile: NostrProfile,
  lastPublishedAt?: number,
) {
  const content = JSON.stringify(profileToContent(profile));
  // Replaceable events must advance even if the previous publication was ahead of our clock.
  const now = Math.floor(Date.now() / 1000);
  const event = finalizeEvent(
    {
      kind: 0,
      content,
      tags: [],
      created_at: lastPublishedAt !== undefined ? Math.max(now, lastPublishedAt + 1) : now,
    },
    sk,
  );
  const successes: string[] = [];
  const failures: Array<{ relay: string; error: string }> = [];

  const publishPromises = relays.map(async (relay) => {
    try {
      await withTimeout(
        Promise.resolve(pool.publish([relay], event)[0]),
        RELAY_PUBLISH_TIMEOUT_MS,
        {
          message: "timeout",
        },
      );
      successes.push(relay);
    } catch (err) {
      failures.push({ relay, error: formatErrorMessage(err) });
    }
  });

  await Promise.all(publishPromises);

  return {
    eventId: event.id,
    successes,
    failures,
    /** Unix timestamp when the event was created. */
    createdAt: event.created_at,
  };
}

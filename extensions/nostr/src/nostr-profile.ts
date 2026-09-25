import { finalizeEvent, SimplePool } from "nostr-tools";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { NostrProfile } from "./config-schema.js";
import { profileToContent } from "./nostr-profile-core.js";

export interface ProfilePublishResult {
  eventId: string;
  successes: string[];
  failures: Array<{ relay: string; error: string }>;
  /** Unix timestamp when the event was created. */
  createdAt: number;
}

const RELAY_PUBLISH_TIMEOUT_MS = 5000;

/** Publish one signed kind:0 event, reporting each relay's result without retrying. */
export async function publishProfile(
  pool: SimplePool,
  sk: Uint8Array,
  relays: string[],
  profile: NostrProfile,
  lastPublishedAt?: number,
): Promise<ProfilePublishResult> {
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

  // Publish to each relay in parallel with timeout
  const publishPromises = relays.map(async (relay) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), RELAY_PUBLISH_TIMEOUT_MS);
      });

      await Promise.race([pool.publish([relay], event)[0], timeoutPromise]);

      successes.push(relay);
    } catch (err) {
      const errorMessage = formatErrorMessage(err);
      failures.push({ relay, error: errorMessage });
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  });

  await Promise.all(publishPromises);

  return {
    eventId: event.id,
    successes,
    failures,
    createdAt: event.created_at,
  };
}

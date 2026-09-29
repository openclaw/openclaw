import { SimplePool, type Event } from "nostr-tools";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { type NostrProfile, NostrProfileSchema } from "./config-schema.js";
import { contentToProfile, type ProfileContent } from "./nostr-profile-core.js";
import { validateUrlSafety } from "./nostr-profile-url-safety.js";

interface ProfileImportResult {
  ok: boolean;
  profile?: NostrProfile;
  /** The raw event (for advanced users) */
  event?: {
    id: string;
    pubkey: string;
    created_at: number;
  };
  error?: string;
  /** Which relays responded */
  relaysQueried: string[];
  /** Which relay provided the winning event */
  sourceRelay?: string;
}

interface ProfileImportOptions {
  pubkey: string;
  relays: string[];
  /** Timeout per relay in milliseconds (default: 5000) */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5000;

function sanitizeProfileUrls(profile: NostrProfile): NostrProfile {
  const result = { ...profile };
  const urlFields = ["picture", "banner", "website"] as const;

  for (const field of urlFields) {
    const value = result[field];
    if (value && typeof value === "string") {
      const validation = validateUrlSafety(value);
      if (!validation.ok) {
        delete result[field];
      }
    }
  }

  return result;
}

/** Import the latest verified kind:0 profile across the configured relays. */
export async function importProfileFromRelays(
  opts: ProfileImportOptions,
): Promise<ProfileImportResult> {
  const { pubkey, relays } = opts;
  const timeoutMs = resolveTimerTimeoutMs(opts.timeoutMs, DEFAULT_TIMEOUT_MS);

  if (!pubkey || !/^[0-9a-fA-F]{64}$/.test(pubkey)) {
    return {
      ok: false,
      error: "Invalid pubkey format (must be 64 hex characters)",
      relaysQueried: [],
    };
  }

  if (relays.length === 0) {
    return {
      ok: false,
      error: "No relays configured",
      relaysQueried: [],
    };
  }

  const pool = new SimplePool();
  const relaysQueried = [...relays];
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    deadlineTimer = setTimeout(resolve, timeoutMs);
    deadlineTimer.unref?.();
  });
  const subscriptions: Array<ReturnType<typeof pool.subscribeMany>> = [];

  try {
    // Keep subscriptions separate: pool-wide ID dedupe runs before signature verification.
    const events: Array<{ event: Event; relay: string }> = [];
    await Promise.race([
      Promise.all(
        relays.map(
          (relay) =>
            new Promise<void>((resolve) => {
              const subscription = pool.subscribeMany(
                [relay],
                { kinds: [0], authors: [pubkey], limit: 1 },
                {
                  onevent(event) {
                    events.push({ event, relay });
                  },
                  oneose() {
                    resolve();
                  },
                  onclose() {
                    resolve();
                  },
                },
              );
              subscriptions.push(subscription);
            }),
        ),
      ),
      deadline,
    ]);

    if (events.length === 0) {
      return {
        ok: false,
        error: "No profile found on any relay",
        relaysQueried,
      };
    }

    // Find the canonical latest replaceable event: newest timestamp, then lowest id.
    const bestEvent = events.reduce((current, candidate) => {
      const candidateIsNewer = candidate.event.created_at > current.event.created_at;
      // NIP-01 breaks replaceable-event timestamp ties with the lowest event id.
      const candidateWinsTie =
        candidate.event.created_at === current.event.created_at &&
        candidate.event.id < current.event.id;
      return candidateIsNewer || candidateWinsTie ? candidate : current;
    });

    let parsedContent: unknown;
    try {
      parsedContent = JSON.parse(bestEvent.event.content);
    } catch {
      return {
        ok: false,
        error: "Profile event has invalid JSON content",
        relaysQueried,
        sourceRelay: bestEvent.relay,
      };
    }
    if (
      typeof parsedContent !== "object" ||
      parsedContent === null ||
      Array.isArray(parsedContent)
    ) {
      return {
        ok: false,
        error: "Profile event content must be a JSON object",
        relaysQueried,
        sourceRelay: bestEvent.relay,
      };
    }
    const content = parsedContent as ProfileContent;

    const profile = contentToProfile(content);

    // Drop unsafe URLs before schema validation so an otherwise valid profile remains importable.
    // Other invalid known fields reject the event atomically instead of silently changing its data.
    const sanitizedProfile = sanitizeProfileUrls(profile);
    const validatedProfile = NostrProfileSchema.safeParse(sanitizedProfile);
    if (!validatedProfile.success) {
      return {
        ok: false,
        error: "Profile event content has invalid fields",
        relaysQueried,
        sourceRelay: bestEvent.relay,
      };
    }

    return {
      ok: true,
      profile: validatedProfile.data,
      event: {
        id: bestEvent.event.id,
        pubkey: bestEvent.event.pubkey,
        created_at: bestEvent.event.created_at,
      },
      relaysQueried,
      sourceRelay: bestEvent.relay,
    };
  } finally {
    if (deadlineTimer) {
      clearTimeout(deadlineTimer);
    }
    // Individual closers catch relay connections that finish after the deadline.
    for (const subscription of subscriptions) {
      subscription.close();
    }
    pool.close(relays);
  }
}

/** Preserve local customizations while filling missing fields from the imported profile. */
export function mergeProfiles(
  local: NostrProfile | undefined,
  imported: NostrProfile | undefined,
): NostrProfile {
  if (!imported) {
    return local ?? {};
  }
  if (!local) {
    return imported;
  }

  return {
    name: local.name ?? imported.name,
    displayName: local.displayName ?? imported.displayName,
    about: local.about ?? imported.about,
    picture: local.picture ?? imported.picture,
    banner: local.banner ?? imported.banner,
    website: local.website ?? imported.website,
    nip05: local.nip05 ?? imported.nip05,
    lud16: local.lud16 ?? imported.lud16,
  };
}

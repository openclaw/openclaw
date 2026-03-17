import { SimplePool, verifyEvent } from "nostr-tools";
import { validateUrlSafety } from "./nostr-profile-http.js";
import { contentToProfile } from "./nostr-profile.js";
const DEFAULT_TIMEOUT_MS = 5e3;
function sanitizeProfileUrls(profile) {
  const result = { ...profile };
  const urlFields = ["picture", "banner", "website"];
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
async function importProfileFromRelays(opts) {
  const { pubkey, relays, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  if (!pubkey || !/^[0-9a-fA-F]{64}$/.test(pubkey)) {
    return {
      ok: false,
      error: "Invalid pubkey format (must be 64 hex characters)",
      relaysQueried: []
    };
  }
  if (relays.length === 0) {
    return {
      ok: false,
      error: "No relays configured",
      relaysQueried: []
    };
  }
  const pool = new SimplePool();
  const relaysQueried = [];
  try {
    const events = [];
    const timeoutPromise = new Promise((resolve) => {
      setTimeout(resolve, timeoutMs);
    });
    const subscriptionPromise = new Promise((resolve) => {
      let completed = 0;
      for (const relay of relays) {
        relaysQueried.push(relay);
        const sub = pool.subscribeMany(
          [relay],
          [
            {
              kinds: [0],
              authors: [pubkey],
              limit: 1
            }
          ],
          {
            onevent(event) {
              events.push({ event, relay });
            },
            oneose() {
              completed++;
              if (completed >= relays.length) {
                resolve();
              }
            },
            onclose() {
              completed++;
              if (completed >= relays.length) {
                resolve();
              }
            }
          }
        );
        setTimeout(() => {
          sub.close();
        }, timeoutMs);
      }
    });
    await Promise.race([subscriptionPromise, timeoutPromise]);
    if (events.length === 0) {
      return {
        ok: false,
        error: "No profile found on any relay",
        relaysQueried
      };
    }
    let bestEvent = null;
    for (const item of events) {
      if (!bestEvent || item.event.created_at > bestEvent.event.created_at) {
        bestEvent = item;
      }
    }
    if (!bestEvent) {
      return {
        ok: false,
        error: "No valid profile event found",
        relaysQueried
      };
    }
    const isValid = verifyEvent(bestEvent.event);
    if (!isValid) {
      return {
        ok: false,
        error: "Profile event has invalid signature",
        relaysQueried,
        sourceRelay: bestEvent.relay
      };
    }
    let content;
    try {
      content = JSON.parse(bestEvent.event.content);
    } catch {
      return {
        ok: false,
        error: "Profile event has invalid JSON content",
        relaysQueried,
        sourceRelay: bestEvent.relay
      };
    }
    const profile = contentToProfile(content);
    const sanitizedProfile = sanitizeProfileUrls(profile);
    return {
      ok: true,
      profile: sanitizedProfile,
      event: {
        id: bestEvent.event.id,
        pubkey: bestEvent.event.pubkey,
        created_at: bestEvent.event.created_at
      },
      relaysQueried,
      sourceRelay: bestEvent.relay
    };
  } finally {
    pool.close(relays);
  }
}
function mergeProfiles(local, imported) {
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
    lud16: local.lud16 ?? imported.lud16
  };
}
export {
  importProfileFromRelays,
  mergeProfiles
};

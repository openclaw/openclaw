import { finalizeEvent } from "nostr-tools";
import { NostrProfileSchema } from "./config-schema.js";
function profileToContent(profile) {
  const validated = NostrProfileSchema.parse(profile);
  const content = {};
  if (validated.name !== void 0) {
    content.name = validated.name;
  }
  if (validated.displayName !== void 0) {
    content.display_name = validated.displayName;
  }
  if (validated.about !== void 0) {
    content.about = validated.about;
  }
  if (validated.picture !== void 0) {
    content.picture = validated.picture;
  }
  if (validated.banner !== void 0) {
    content.banner = validated.banner;
  }
  if (validated.website !== void 0) {
    content.website = validated.website;
  }
  if (validated.nip05 !== void 0) {
    content.nip05 = validated.nip05;
  }
  if (validated.lud16 !== void 0) {
    content.lud16 = validated.lud16;
  }
  return content;
}
function contentToProfile(content) {
  const profile = {};
  if (content.name !== void 0) {
    profile.name = content.name;
  }
  if (content.display_name !== void 0) {
    profile.displayName = content.display_name;
  }
  if (content.about !== void 0) {
    profile.about = content.about;
  }
  if (content.picture !== void 0) {
    profile.picture = content.picture;
  }
  if (content.banner !== void 0) {
    profile.banner = content.banner;
  }
  if (content.website !== void 0) {
    profile.website = content.website;
  }
  if (content.nip05 !== void 0) {
    profile.nip05 = content.nip05;
  }
  if (content.lud16 !== void 0) {
    profile.lud16 = content.lud16;
  }
  return profile;
}
function createProfileEvent(sk, profile, lastPublishedAt) {
  const content = profileToContent(profile);
  const contentJson = JSON.stringify(content);
  const now = Math.floor(Date.now() / 1e3);
  const createdAt = lastPublishedAt !== void 0 ? Math.max(now, lastPublishedAt + 1) : now;
  const event = finalizeEvent(
    {
      kind: 0,
      content: contentJson,
      tags: [],
      created_at: createdAt
    },
    sk
  );
  return event;
}
const RELAY_PUBLISH_TIMEOUT_MS = 5e3;
async function publishProfileEvent(pool, relays, event) {
  const successes = [];
  const failures = [];
  const publishPromises = relays.map(async (relay) => {
    try {
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error("timeout")), RELAY_PUBLISH_TIMEOUT_MS);
      });
      await Promise.race([pool.publish([relay], event), timeoutPromise]);
      successes.push(relay);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      failures.push({ relay, error: errorMessage });
    }
  });
  await Promise.all(publishPromises);
  return {
    eventId: event.id,
    successes,
    failures,
    createdAt: event.created_at
  };
}
async function publishProfile(pool, sk, relays, profile, lastPublishedAt) {
  const event = createProfileEvent(sk, profile, lastPublishedAt);
  return publishProfileEvent(pool, relays, event);
}
function validateProfile(profile) {
  const result = NostrProfileSchema.safeParse(profile);
  if (result.success) {
    return { valid: true, profile: result.data };
  }
  return {
    valid: false,
    errors: result.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`)
  };
}
function sanitizeProfileForDisplay(profile) {
  const escapeHtml = (str) => {
    if (str === void 0) {
      return void 0;
    }
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  };
  return {
    name: escapeHtml(profile.name),
    displayName: escapeHtml(profile.displayName),
    about: escapeHtml(profile.about),
    picture: profile.picture,
    // URLs already validated by schema
    banner: profile.banner,
    website: profile.website,
    nip05: escapeHtml(profile.nip05),
    lud16: escapeHtml(profile.lud16)
  };
}
export {
  contentToProfile,
  createProfileEvent,
  profileToContent,
  publishProfile,
  publishProfileEvent,
  sanitizeProfileForDisplay,
  validateProfile
};

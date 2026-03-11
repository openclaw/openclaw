import type { OpenClawConfig } from "../../config/config.js";
import { updateSessionStore, type SessionEntry } from "../../config/sessions.js";
import {
  ensureAuthProfileStore,
  isProfileInCooldown,
  resolveAuthProfileOrder,
  suggestOAuthProfileIdForLegacyDefault,
} from "../auth-profiles.js";
import { normalizeProviderId } from "../model-selection.js";

function isProfileForProvider(params: {
  provider: string;
  profileId: string;
  store: ReturnType<typeof ensureAuthProfileStore>;
}): boolean {
  const entry = params.store.profiles[params.profileId];
  if (!entry?.provider) {
    return false;
  }
  return normalizeProviderId(entry.provider) === normalizeProviderId(params.provider);
}

export async function clearSessionAuthProfileOverride(params: {
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
  storePath?: string;
}) {
  const { sessionEntry, sessionStore, sessionKey, storePath } = params;
  delete sessionEntry.authProfileOverride;
  delete sessionEntry.authProfileOverrideSource;
  delete sessionEntry.authProfileOverrideCompactionCount;
  sessionEntry.updatedAt = Date.now();
  sessionStore[sessionKey] = sessionEntry;
  if (storePath) {
    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = sessionEntry;
    });
  }
}

export async function resolveSessionAuthProfileOverride(params: {
  cfg: OpenClawConfig;
  provider: string;
  agentDir: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  storePath?: string;
  isNewSession: boolean;
}): Promise<string | undefined> {
  const {
    cfg,
    provider,
    agentDir,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    isNewSession,
  } = params;
  if (!sessionEntry || !sessionStore || !sessionKey) {
    return sessionEntry?.authProfileOverride;
  }

  const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  const order = resolveAuthProfileOrder({ cfg, store, provider });
  let current = sessionEntry.authProfileOverride?.trim();

  if (current && !store.profiles[current]) {
    await clearSessionAuthProfileOverride({ sessionEntry, sessionStore, sessionKey, storePath });
    current = undefined;
  }

  if (current && !isProfileForProvider({ provider, profileId: current, store })) {
    await clearSessionAuthProfileOverride({ sessionEntry, sessionStore, sessionKey, storePath });
    current = undefined;
  }

  if (current && order.length > 0 && !order.includes(current)) {
    await clearSessionAuthProfileOverride({ sessionEntry, sessionStore, sessionKey, storePath });
    current = undefined;
  }

  if (order.length === 0) {
    return undefined;
  }

  const resolveCanonicalProfile = (profileId: string | undefined): string | undefined => {
    if (!profileId) {
      return undefined;
    }
    const legacyEntry = store.profiles[profileId];
    if (legacyEntry?.type !== "oauth") {
      return profileId;
    }
    const legacyHasIdentity =
      (typeof legacyEntry.email === "string" && legacyEntry.email.trim().length > 0) ||
      (typeof legacyEntry.accountId === "string" && legacyEntry.accountId.length > 0);
    const matchesLegacyIdentity = (candidateId: string) => {
      const entry = store.profiles[candidateId];
      if (entry?.type !== "oauth") {
        return false;
      }
      const sameEmail =
        typeof legacyEntry.email === "string" &&
        typeof entry.email === "string" &&
        legacyEntry.email.trim().length > 0 &&
        legacyEntry.email.trim() === entry.email.trim();
      const sameAccount =
        typeof legacyEntry.accountId === "string" &&
        typeof entry.accountId === "string" &&
        legacyEntry.accountId.length > 0 &&
        legacyEntry.accountId === entry.accountId;
      return sameEmail || sameAccount;
    };
    const suggested = suggestOAuthProfileIdForLegacyDefault({
      cfg,
      store,
      provider,
      legacyProfileId: profileId,
    });
    const candidate = suggested && suggested !== profileId ? suggested : undefined;
    if (
      candidate &&
      order.includes(candidate) &&
      !isProfileInCooldown(store, candidate) &&
      (!legacyHasIdentity || matchesLegacyIdentity(candidate))
    ) {
      return candidate;
    }
    if (profileId.endsWith(":default")) {
      const fallback = order.find((candidateId) => {
        if (candidateId === profileId || isProfileInCooldown(store, candidateId)) {
          return false;
        }
        if (candidateId.endsWith(":default")) {
          return false;
        }
        const entry = store.profiles[candidateId];
        if (entry?.type !== "oauth") {
          return false;
        }
        if (matchesLegacyIdentity(candidateId)) {
          return true;
        }
        if (legacyHasIdentity) {
          return false;
        }
        // Compatibility fallback: only when legacy default has no usable identity.
        return true;
      });
      if (fallback) {
        return fallback;
      }
    }
    return profileId;
  };

  const pickFirstAvailable = () =>
    order.find((profileId) => !isProfileInCooldown(store, profileId)) ?? order[0];
  const pickNextAvailable = (active: string) => {
    const startIndex = order.indexOf(active);
    if (startIndex < 0) {
      return pickFirstAvailable();
    }
    for (let offset = 1; offset <= order.length; offset += 1) {
      const candidate = order[(startIndex + offset) % order.length];
      if (!isProfileInCooldown(store, candidate)) {
        return candidate;
      }
    }
    return order[startIndex] ?? order[0];
  };

  const compactionCount = sessionEntry.compactionCount ?? 0;
  const storedCompaction =
    typeof sessionEntry.authProfileOverrideCompactionCount === "number"
      ? sessionEntry.authProfileOverrideCompactionCount
      : compactionCount;

  const source =
    sessionEntry.authProfileOverrideSource ??
    (typeof sessionEntry.authProfileOverrideCompactionCount === "number"
      ? "auto"
      : current
        ? "user"
        : undefined);
  if (source === "user" && current && !isNewSession) {
    return current;
  }

  let next = resolveCanonicalProfile(current);
  if (isNewSession) {
    next = resolveCanonicalProfile(
      current ? pickNextAvailable(next ?? current) : pickFirstAvailable(),
    );
  } else if (current && compactionCount > storedCompaction) {
    next = resolveCanonicalProfile(pickNextAvailable(next ?? current));
  } else if (!next || isProfileInCooldown(store, next)) {
    next = resolveCanonicalProfile(pickFirstAvailable());
  }

  if (!next) {
    return current;
  }
  const shouldPersist =
    next !== sessionEntry.authProfileOverride ||
    sessionEntry.authProfileOverrideSource !== "auto" ||
    sessionEntry.authProfileOverrideCompactionCount !== compactionCount;
  if (shouldPersist) {
    sessionEntry.authProfileOverride = next;
    sessionEntry.authProfileOverrideSource = "auto";
    sessionEntry.authProfileOverrideCompactionCount = compactionCount;
    sessionEntry.updatedAt = Date.now();
    sessionStore[sessionKey] = sessionEntry;
    if (storePath) {
      await updateSessionStore(storePath, (store) => {
        store[sessionKey] = sessionEntry;
      });
    }
  }

  return next;
}

import { upsertSessionEntry } from "../../config/sessions.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveAuthProfileOrder } from "../auth-profiles/order.js";
import { ensureAuthProfileStore, hasAnyAuthProfileStoreSource } from "../auth-profiles/store.js";
import { isProfileInCooldown } from "../auth-profiles/usage.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";

function isProfileForProvider(params: {
  cfg: OpenClawConfig;
  providers: readonly string[];
  profileId: string;
  store: ReturnType<typeof ensureAuthProfileStore>;
}): boolean {
  const entry = params.store.profiles[params.profileId];
  if (!entry?.provider) {
    return false;
  }
  const entryProviderKey = resolveProviderIdForAuth(entry.provider, { config: params.cfg });
  return params.providers.some(
    (provider) => resolveProviderIdForAuth(provider, { config: params.cfg }) === entryProviderKey,
  );
}

export async function clearSessionAuthProfileOverride(params: {
  sessionEntry: SessionEntry;
  sessionStore: Record<string, SessionEntry>;
  sessionKey: string;
}) {
  const { sessionEntry, sessionStore, sessionKey } = params;
  delete sessionEntry.authProfileOverride;
  delete sessionEntry.authProfileOverrideSource;
  delete sessionEntry.authProfileOverrideCompactionCount;
  sessionEntry.updatedAt = Date.now();
  sessionStore[sessionKey] = sessionEntry;
  upsertSessionEntry({
    agentId: resolveAgentIdFromSessionKey(sessionKey),
    sessionKey,
    entry: sessionEntry,
  });
}

export async function resolveSessionAuthProfileOverride(params: {
  cfg: OpenClawConfig;
  provider: string;
  acceptedProviderIds?: readonly string[];
  agentDir: string;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey?: string;
  isNewSession: boolean;
}): Promise<string | undefined> {
  const { cfg, provider, agentDir, sessionEntry, sessionStore, sessionKey, isNewSession } = params;
  if (!sessionEntry || !sessionStore || !sessionKey) {
    return sessionEntry?.authProfileOverride;
  }

  const hasConfiguredAuthProfiles =
    Boolean(params.cfg.auth?.profiles && Object.keys(params.cfg.auth.profiles).length > 0) ||
    Boolean(params.cfg.auth?.order && Object.keys(params.cfg.auth.order).length > 0);
  if (
    !sessionEntry.authProfileOverride?.trim() &&
    !hasConfiguredAuthProfiles &&
    !hasAnyAuthProfileStoreSource(agentDir)
  ) {
    return undefined;
  }

  const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  const acceptedProviders =
    params.acceptedProviderIds && params.acceptedProviderIds.length > 0
      ? [...new Set(params.acceptedProviderIds)]
      : [provider];
  const order = [
    ...new Set(
      acceptedProviders.flatMap((acceptedProvider) =>
        resolveAuthProfileOrder({ cfg, store, provider: acceptedProvider }),
      ),
    ),
  ];
  let current = sessionEntry.authProfileOverride?.trim();
  const source =
    sessionEntry.authProfileOverrideSource ??
    (typeof sessionEntry.authProfileOverrideCompactionCount === "number"
      ? "auto"
      : current
        ? "user"
        : undefined);

  if (current && !store.profiles[current]) {
    await clearSessionAuthProfileOverride({ sessionEntry, sessionStore, sessionKey });
    current = undefined;
  }

  if (
    current &&
    !isProfileForProvider({ cfg, providers: acceptedProviders, profileId: current, store })
  ) {
    await clearSessionAuthProfileOverride({ sessionEntry, sessionStore, sessionKey });
    current = undefined;
  }

  // Explicit user picks should survive provider rotation order changes.
  if (current && order.length > 0 && !order.includes(current) && source !== "user") {
    await clearSessionAuthProfileOverride({ sessionEntry, sessionStore, sessionKey });
    current = undefined;
  }

  if (order.length === 0) {
    return undefined;
  }

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
  const replacementForUnusableCurrent =
    current && isProfileInCooldown(store, current)
      ? order.find((profileId) => profileId !== current && !isProfileInCooldown(store, profileId))
      : undefined;
  if (replacementForUnusableCurrent) {
    current = undefined;
  }
  if (source === "user" && current && !isNewSession) {
    return current;
  }

  let next = current;
  if (replacementForUnusableCurrent) {
    next = replacementForUnusableCurrent;
  } else if (isNewSession) {
    next = current ? pickNextAvailable(current) : pickFirstAvailable();
  } else if (current && compactionCount > storedCompaction) {
    next = pickNextAvailable(current);
  } else if (!current || isProfileInCooldown(store, current)) {
    next = pickFirstAvailable();
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
    upsertSessionEntry({
      agentId: resolveAgentIdFromSessionKey(sessionKey),
      sessionKey,
      entry: sessionEntry,
    });
  }

  return next;
}

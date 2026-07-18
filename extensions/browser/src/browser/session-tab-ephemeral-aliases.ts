/**
 * Process-local aliases for durable storage keys and non-durable tab rows.
 */
type AliasIdentity = {
  sessionKey: string;
  targetId: string;
  profile?: string;
};

export type VolatileAliasTarget = {
  sessionKey: string;
  tabKey: string;
};

const durableAliasStateSymbol = Symbol.for(
  "openclaw.browser.session-tabs.interaction-storage-keys",
);
const volatileAliasStateSymbol = Symbol.for("openclaw.browser.session-tabs.volatile-aliases");

function interactionKey(identity: AliasIdentity): string {
  return `${identity.sessionKey}\u0000${identity.profile ?? ""}\u0000${identity.targetId}`;
}

function normalizedTargetIds(
  identity: AliasIdentity,
  aliases: Array<string | undefined>,
): Set<string> {
  return new Set([
    identity.targetId,
    ...aliases.flatMap((alias) => {
      const targetId = alias?.trim();
      return targetId ? [targetId] : [];
    }),
  ]);
}

function durableKeysByInteraction(): Map<string, string> {
  const state = globalThis as typeof globalThis & {
    [durableAliasStateSymbol]?: Map<string, string>;
  };
  state[durableAliasStateSymbol] ??= new Map();
  return state[durableAliasStateSymbol];
}

export function clearDurableTabAliases(storageKey: string): void {
  const aliases = durableKeysByInteraction();
  for (const [key, mappedStorageKey] of aliases) {
    if (mappedStorageKey === storageKey) {
      aliases.delete(key);
    }
  }
}

export function rememberDurableTabAliases(
  identity: AliasIdentity,
  aliases: Array<string | undefined>,
  storageKey: string,
): void {
  clearDurableTabAliases(storageKey);
  const mappings = durableKeysByInteraction();
  for (const targetId of normalizedTargetIds(identity, aliases)) {
    mappings.set(interactionKey({ ...identity, targetId }), storageKey);
  }
}

export function resolveDurableTabAlias(identity: AliasIdentity): string | undefined {
  return durableKeysByInteraction().get(interactionKey(identity));
}

function volatileAliasesByInteraction(): Map<string, VolatileAliasTarget> {
  const state = globalThis as typeof globalThis & {
    [volatileAliasStateSymbol]?: Map<string, VolatileAliasTarget>;
  };
  state[volatileAliasStateSymbol] ??= new Map();
  return state[volatileAliasStateSymbol];
}

export function clearVolatileTabAliases(sessionKey: string, tabKey: string): void {
  const aliases = volatileAliasesByInteraction();
  for (const [key, target] of aliases) {
    if (target.sessionKey === sessionKey && target.tabKey === tabKey) {
      aliases.delete(key);
    }
  }
}

export function rememberVolatileTabAliases(
  identity: AliasIdentity,
  aliases: Array<string | undefined>,
  tabKey: string,
): void {
  clearVolatileTabAliases(identity.sessionKey, tabKey);
  for (const targetId of normalizedTargetIds(identity, aliases)) {
    volatileAliasesByInteraction().set(interactionKey({ ...identity, targetId }), {
      sessionKey: identity.sessionKey,
      tabKey,
    });
  }
}

export function resolveVolatileTabAlias(identity: AliasIdentity): VolatileAliasTarget | undefined {
  return volatileAliasesByInteraction().get(interactionKey(identity));
}

export function forgetVolatileTabAlias(identity: AliasIdentity): void {
  volatileAliasesByInteraction().delete(interactionKey(identity));
}

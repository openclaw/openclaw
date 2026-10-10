/**
 * Process-local aliases for durable storage keys and non-durable tab rows.
 */
import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";
import { normalizeTrimmedStringList } from "openclaw/plugin-sdk/string-coerce-runtime";
import { browserSessionTabRouteKey, type BrowserSessionTabRoute } from "./session-tab-route.js";

type AliasIdentity = {
  sessionKey: string;
  targetId: string;
  route?: BrowserSessionTabRoute;
  profile?: string;
};

type VolatileAliasTarget = {
  sessionKey: string;
  tabKey: string;
};

const durableAliasStateSymbol = Symbol.for(
  "openclaw.browser.session-tabs.interaction-storage-keys",
);
const durableExactStateSymbol = Symbol.for(
  "openclaw.browser.session-tabs.exact-interaction-storage-keys",
);
const volatileAliasStateSymbol = Symbol.for("openclaw.browser.session-tabs.volatile-aliases");
const volatileExactStateSymbol = Symbol.for("openclaw.browser.session-tabs.exact-volatile-aliases");

function interactionKey(identity: AliasIdentity): string {
  const route = browserSessionTabRouteKey(identity.route ?? { kind: "browser-control" });
  return `${identity.sessionKey}\u0000${route}\u0000${identity.profile ?? ""}\u0000${identity.targetId}`;
}

function normalizedAliases<T extends string | undefined>(
  primary: T,
  aliases: Array<string | undefined>,
): Set<T | string> {
  return new Set([primary, ...normalizeTrimmedStringList(aliases)]);
}

function durableKeysByInteraction(kind: "alias" | "exact" = "alias"): Map<string, Set<string>> {
  return resolveGlobalMap(kind === "exact" ? durableExactStateSymbol : durableAliasStateSymbol);
}

function removeAliasTarget<T extends Set<string> | Map<string, VolatileAliasTarget>>(
  mappings: Map<string, T>,
  targetKey: string,
): void {
  for (const [key, targets] of mappings) {
    targets.delete(targetKey);
    if (targets.size === 0) {
      mappings.delete(key);
    }
  }
}

export function resetDurableTabAliases(): void {
  durableKeysByInteraction().clear();
  durableKeysByInteraction("exact").clear();
}

export function clearDurableTabAliases(storageKey: string): void {
  removeAliasTarget(durableKeysByInteraction(), storageKey);
  removeAliasTarget(durableKeysByInteraction("exact"), storageKey);
}

export function rememberDurableTabAliases(
  identity: AliasIdentity,
  aliases: Array<string | undefined>,
  storageKey: string,
  profileAliases: Array<string | undefined> = [],
): void {
  clearDurableTabAliases(storageKey);
  const mappings = durableKeysByInteraction();
  const exactMappings = durableKeysByInteraction("exact");
  for (const profile of normalizedAliases(identity.profile, profileAliases)) {
    const exactKey = interactionKey({ ...identity, profile });
    const exactStorageKeys = exactMappings.get(exactKey) ?? new Set<string>();
    exactStorageKeys.add(storageKey);
    exactMappings.set(exactKey, exactStorageKeys);
    for (const targetId of normalizedAliases(identity.targetId, aliases)) {
      const key = interactionKey({ ...identity, profile, targetId });
      const storageKeys = mappings.get(key) ?? new Set<string>();
      storageKeys.add(storageKey);
      mappings.set(key, storageKeys);
    }
  }
}

function readAliasCandidates<T>(
  targets: { size: number; values: () => Iterator<T, undefined> } | undefined,
) {
  return {
    target: targets?.size === 1 ? targets.values().next().value : undefined,
    hasCandidates: (targets?.size ?? 0) > 0,
  };
}

export function readDurableTabAlias(identity: AliasIdentity, kind: "alias" | "exact" = "alias") {
  return readAliasCandidates(durableKeysByInteraction(kind).get(interactionKey(identity)));
}

function volatileAliasTargetKey(target: VolatileAliasTarget): string {
  return JSON.stringify([target.sessionKey, target.tabKey]);
}

function volatileAliasesByInteraction(
  kind: "alias" | "exact" = "alias",
): Map<string, Map<string, VolatileAliasTarget>> {
  return resolveGlobalMap(kind === "exact" ? volatileExactStateSymbol : volatileAliasStateSymbol);
}

export function clearVolatileTabAliases(sessionKey: string, tabKey: string): void {
  const targetKey = volatileAliasTargetKey({ sessionKey, tabKey });
  removeAliasTarget(volatileAliasesByInteraction(), targetKey);
  removeAliasTarget(volatileAliasesByInteraction("exact"), targetKey);
}

export function rememberVolatileTabAliases(
  identity: AliasIdentity,
  aliases: Array<string | undefined>,
  tabKey: string,
  profileAliases: Array<string | undefined> = [],
): void {
  clearVolatileTabAliases(identity.sessionKey, tabKey);
  const target = { sessionKey: identity.sessionKey, tabKey };
  const mappings = volatileAliasesByInteraction();
  const exactMappings = volatileAliasesByInteraction("exact");
  for (const profile of normalizedAliases(identity.profile, profileAliases)) {
    const exactKey = interactionKey({ ...identity, profile });
    const exactTargets = exactMappings.get(exactKey) ?? new Map<string, VolatileAliasTarget>();
    exactTargets.set(volatileAliasTargetKey(target), target);
    exactMappings.set(exactKey, exactTargets);
    for (const targetId of normalizedAliases(identity.targetId, aliases)) {
      const key = interactionKey({ ...identity, profile, targetId });
      const targets = mappings.get(key) ?? new Map<string, VolatileAliasTarget>();
      targets.set(volatileAliasTargetKey(target), target);
      mappings.set(key, targets);
    }
  }
}

export function readVolatileTabAlias(identity: AliasIdentity, kind: "alias" | "exact" = "alias") {
  return readAliasCandidates(volatileAliasesByInteraction(kind).get(interactionKey(identity)));
}

export function forgetVolatileTabAlias(identity: AliasIdentity): void {
  volatileAliasesByInteraction().delete(interactionKey(identity));
  volatileAliasesByInteraction("exact").delete(interactionKey(identity));
}

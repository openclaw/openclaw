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

function createTabAliasIndex<T>(
  aliasSymbol: string,
  exactSymbol: string,
  keyOf: (target: T) => string,
) {
  const mappings = (kind: "alias" | "exact") =>
    resolveGlobalMap<string, Map<string, T>>(
      Symbol.for(kind === "exact" ? exactSymbol : aliasSymbol),
    );
  const clear = (targetKey: string) => {
    for (const kind of ["alias", "exact"] as const) {
      const index = mappings(kind);
      for (const [key, targets] of index) {
        targets.delete(targetKey);
        if (targets.size === 0) {
          index.delete(key);
        }
      }
    }
  };
  return {
    clear,
    reset: () => {
      mappings("alias").clear();
      mappings("exact").clear();
    },
    forget: (identity: AliasIdentity) => {
      mappings("alias").delete(interactionKey(identity));
      mappings("exact").delete(interactionKey(identity));
    },
    remember: (
      identity: AliasIdentity,
      aliases: Array<string | undefined>,
      target: T,
      profileAliases: Array<string | undefined> = [],
    ) => {
      const targetKey = keyOf(target);
      clear(targetKey);
      const add = (kind: "alias" | "exact", aliasIdentity: AliasIdentity) => {
        const index = mappings(kind);
        const key = interactionKey(aliasIdentity);
        const targets = index.get(key) ?? new Map<string, T>();
        targets.set(targetKey, target);
        index.set(key, targets);
      };
      for (const profile of normalizedAliases(identity.profile, profileAliases)) {
        add("exact", { ...identity, profile });
        for (const targetId of normalizedAliases(identity.targetId, aliases)) {
          add("alias", { ...identity, profile, targetId });
        }
      }
    },
    read: (identity: AliasIdentity, kind: "alias" | "exact" = "alias") => {
      const targets = mappings(kind).get(interactionKey(identity));
      return {
        target: targets?.size === 1 ? targets.values().next().value : undefined,
        hasCandidates: (targets?.size ?? 0) > 0,
      };
    },
  };
}

const durableAliases = createTabAliasIndex(
  "openclaw.browser.session-tabs.interaction-storage-keys",
  "openclaw.browser.session-tabs.exact-interaction-storage-keys",
  (storageKey: string) => storageKey,
);

export const resetDurableTabAliases = durableAliases.reset;
export const clearDurableTabAliases = durableAliases.clear;
export const rememberDurableTabAliases = durableAliases.remember;
export const readDurableTabAlias = durableAliases.read;

function volatileAliasTargetKey(target: VolatileAliasTarget): string {
  return JSON.stringify([target.sessionKey, target.tabKey]);
}

const volatileAliases = createTabAliasIndex(
  "openclaw.browser.session-tabs.volatile-aliases",
  "openclaw.browser.session-tabs.exact-volatile-aliases",
  volatileAliasTargetKey,
);

export function clearVolatileTabAliases(sessionKey: string, tabKey: string): void {
  volatileAliases.clear(volatileAliasTargetKey({ sessionKey, tabKey }));
}

export function rememberVolatileTabAliases(
  identity: AliasIdentity,
  aliases: Array<string | undefined>,
  tabKey: string,
  profileAliases: Array<string | undefined> = [],
): void {
  volatileAliases.remember(
    identity,
    aliases,
    { sessionKey: identity.sessionKey, tabKey },
    profileAliases,
  );
}

export const readVolatileTabAlias = volatileAliases.read;
export const forgetVolatileTabAlias = volatileAliases.forget;

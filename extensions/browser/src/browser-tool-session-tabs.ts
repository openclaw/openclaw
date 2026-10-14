import {
  asNullableRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { BrowserSessionTabAuthority } from "./browser-runtime-state.js";
import type { BrowserTabOwnership } from "./browser/client.types.js";
import { resolveBrowserSessionKey } from "./browser/session-tab-identity.js";
import type * as sessionTabRegistry from "./browser/session-tab-registry.js";
import type { BrowserSessionTabRoute } from "./browser/session-tab-route.js";

type SessionTabRegistry = Pick<
  typeof sessionTabRegistry,
  "trackSessionBrowserTab" | "touchSessionBrowserTab" | "untrackSessionBrowserTab"
>;

function readOpenedTab(result: unknown): {
  targetId?: string;
  aliases: string[];
  profile?: string;
  ownership?: BrowserTabOwnership;
} {
  const opened = asNullableRecord(result);
  if (!opened) {
    return { aliases: [] };
  }
  const targetId = normalizeOptionalString(opened.targetId);
  const aliases = [
    targetId,
    normalizeOptionalString(opened.tabId),
    normalizeOptionalString(opened.label),
    normalizeOptionalString(opened.suggestedTargetId),
  ].filter((alias): alias is string => Boolean(alias));
  const profile = normalizeOptionalString(opened.resolvedProfile);
  const rawOwnership =
    opened.ownership && typeof opened.ownership === "object"
      ? (opened.ownership as BrowserTabOwnership)
      : undefined;
  // Older browser hosts do not return resolvedProfile. Their durable fingerprint
  // cannot prove which configured profile owns the tab, so keep that tab volatile.
  const ownership = rawOwnership?.status === "durable" && !profile ? undefined : rawOwnership;
  return { targetId, aliases: [...new Set(aliases)], profile, ownership };
}

export function stripBrowserOpenInternalMetadata(value: unknown): unknown {
  const record = asNullableRecord(value);
  if (!record) {
    return value;
  }
  const { ownership: _ownership, resolvedProfile: _resolvedProfile, ...agentVisible } = record;
  return agentVisible;
}

export function createBrowserToolSessionTabs(params: {
  agentId?: string;
  sessionKey?: string;
  requestedProfile?: string;
  defaultProfile: string;
  baseUrl?: string;
  nodeRoute?: Extract<BrowserSessionTabRoute, { kind: "node-proxy" }>;
  routeProfile?: () => string | undefined;
  isHostFallbackActive?: () => boolean;
  registry: SessionTabRegistry;
  authority?: BrowserSessionTabAuthority;
}) {
  const sessionKey = resolveBrowserSessionKey(params.sessionKey, params.agentId);
  if (params.sessionKey?.trim() && !sessionKey) {
    throw new Error(
      "Browser tab ownership requires an agent-qualified session key or an explicit agent id.",
    );
  }
  const trackedRoute = (): BrowserSessionTabRoute =>
    params.nodeRoute && !params.isHostFallbackActive?.()
      ? params.nodeRoute
      : { kind: "browser-control", ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}) };
  const trackedProfile = (route: BrowserSessionTabRoute) =>
    route.kind === "node-proxy"
      ? (params.routeProfile?.() ?? params.requestedProfile)
      : route.baseUrl && !params.requestedProfile
        ? undefined
        : (params.requestedProfile ?? params.defaultProfile);
  const identity = (targetId: string) => {
    const route = trackedRoute();
    return {
      sessionKey,
      targetId,
      route,
      profile: trackedProfile(route),
      ...(params.authority ? { authority: params.authority } : {}),
    };
  };
  return {
    touch: async (targetId: string | undefined): Promise<void> => {
      if (targetId) {
        await params.registry.touchSessionBrowserTab(identity(targetId));
      }
    },
    untrack: async (targetId: string | undefined): Promise<void> => {
      if (targetId) {
        await params.registry.untrackSessionBrowserTab(identity(targetId));
      }
    },
    trackOpened: async (
      result: unknown,
      closeTab: (targetId: string, openedProfile?: string) => Promise<void>,
    ): Promise<void> => {
      const route = trackedRoute();
      const fallbackProfile = trackedProfile(route);
      const opened = readOpenedTab(result);
      const profile = opened.profile ?? fallbackProfile;
      try {
        await params.registry.trackSessionBrowserTab({
          sessionKey,
          targetId: opened.targetId,
          route,
          profile,
          ...(fallbackProfile && opened.profile && opened.profile !== fallbackProfile
            ? { profileAliases: [fallbackProfile] }
            : {}),
          // Sandbox/browser-bridge tabs belong to a different browser process.
          // Keep them process-local even if that server returned durable metadata.
          ownership:
            route.kind === "browser-control" && route.baseUrl ? undefined : opened.ownership,
          aliases: opened.aliases,
          ...(params.authority ? { authority: params.authority } : {}),
        });
      } catch (trackingError) {
        if (!opened.targetId) {
          throw trackingError;
        }
        try {
          await closeTab(opened.targetId, profile);
        } catch (closeError) {
          throw Object.assign(
            new Error("Failed to register browser tab cleanup and close the newly opened tab", {
              cause: closeError,
            }),
            {
              name: "BrowserTabTrackingCompensationError",
              errors: [trackingError, closeError],
            },
          );
        }
        throw trackingError;
      }
    },
  };
}

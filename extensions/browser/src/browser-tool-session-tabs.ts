/**
 * Session tracking for tabs created through the browser tool.
 */
import {
  asNullableRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { BrowserTabOwnership } from "./browser/client.types.js";
import { withoutBrowserRequestScope, getBrowserRequestScope } from "./browser/request-scope.js";
import type { BrowserSessionScope } from "./browser/session-scope.js";
import {
  deleteVolatileRegistrations,
  type VolatileSessionTab,
} from "./browser/session-tab-process-state.js";
import type { BrowserSessionTabRoute } from "./browser/session-tab-route.js";
import { resolveVolatile } from "./browser/session-tab-tracking.js";

type SessionTabParams = {
  sessionKey?: string;
  sessionId?: string;
  lifecycleRevision?: string;
  targetId?: string;
  route?: BrowserSessionTabRoute;
  profile?: string;
  profileAliases?: Array<string | undefined>;
  ownership?: BrowserTabOwnership;
  aliases?: Array<string | undefined>;
};

type SessionTabRegistry = {
  trackSessionBrowserTab: (params: SessionTabParams) => void;
  touchSessionBrowserTab: (params: SessionTabParams) => void;
  untrackSessionBrowserTab: (params: SessionTabParams) => void;
};

function readOpenedTab(result: unknown): {
  targetId?: string;
  aliases: string[];
  profile?: string;
  ownership?: BrowserTabOwnership;
} {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { aliases: [] };
  }
  const opened = result as Record<string, unknown>;
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
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const {
    ownership: _ownership,
    resolvedProfile: _resolvedProfile,
    ...agentVisible
  } = value as Record<string, unknown>;
  return agentVisible;
}

export async function compensateBrowserTabTrackingFailure(
  trackingError: unknown,
  close: () => Promise<unknown>,
): Promise<never> {
  try {
    await close();
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

export async function trackOpenedBrowserTab(params: {
  result: unknown;
  sessionKey?: string;
  fallbackProfile?: string;
  route: BrowserSessionTabRoute;
  track: SessionTabRegistry["trackSessionBrowserTab"];
  closeTab: (targetId: string, profile?: string, ownership?: BrowserTabOwnership) => Promise<void>;
}): Promise<void> {
  const scope = getBrowserRequestScope()?.session;
  if (scope && params.route.kind === "browser-control" && !params.route.baseUrl) {
    return; // The profile owner associated this tab before publishing it.
  }
  const opened = readOpenedTab(params.result);
  const profile = opened.profile ?? params.fallbackProfile;
  try {
    params.track({
      sessionKey: scope?.sessionKey ?? params.sessionKey,
      ...(scope ? { sessionId: scope.sessionId, lifecycleRevision: scope.lifecycleRevision } : {}),
      targetId: opened.targetId,
      route: params.route,
      profile,
      ...(params.fallbackProfile && opened.profile && opened.profile !== params.fallbackProfile
        ? { profileAliases: [params.fallbackProfile] }
        : {}),
      // Sandbox/browser-bridge tabs belong to a different browser process.
      // Keep them process-local even if that server returned durable metadata.
      ownership:
        params.route.kind === "browser-control" && params.route.baseUrl
          ? undefined
          : opened.ownership,
      aliases: opened.aliases,
    });
  } catch (trackingError) {
    if (!opened.targetId) {
      throw trackingError;
    }
    await compensateBrowserTabTrackingFailure(trackingError, () =>
      params.closeTab(opened.targetId!, profile, opened.ownership),
    );
  }
}

export function createBrowserToolSessionTabs(params: {
  sessionKey?: string;
  requestedProfile?: string;
  defaultProfile: string;
  baseUrl?: string;
  nodeRoute?: Extract<BrowserSessionTabRoute, { kind: "node-proxy" }>;
  routeProfile?: () => string | undefined;
  isHostFallbackActive?: () => boolean;
  registry: SessionTabRegistry;
}) {
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
      sessionKey: params.sessionKey,
      sessionId: getBrowserRequestScope()?.session?.sessionId,
      lifecycleRevision: getBrowserRequestScope()?.session?.lifecycleRevision,
      targetId,
      route,
      profile: trackedProfile(route),
    };
  };
  return {
    touch: (targetId: string | undefined): void => {
      const route = trackedRoute();
      if (getBrowserRequestScope()?.session && route.kind === "browser-control" && !route.baseUrl) {
        return;
      }
      if (targetId) {
        params.registry.touchSessionBrowserTab(identity(targetId));
      }
    },
    untrack: (targetId: string | undefined): void => {
      const route = trackedRoute();
      if (getBrowserRequestScope()?.session && route.kind === "browser-control" && !route.baseUrl) {
        return;
      }
      if (targetId) {
        params.registry.untrackSessionBrowserTab(identity(targetId));
      }
    },
    trackOpened: async (
      result: unknown,
      closeTab: (
        targetId: string,
        openedProfile?: string,
        ownership?: BrowserTabOwnership,
      ) => Promise<void>,
    ): Promise<void> => {
      const route = trackedRoute();
      const profile = trackedProfile(route);
      await trackOpenedBrowserTab({
        result,
        sessionKey: params.sessionKey,
        fallbackProfile: profile,
        route,
        track: params.registry.trackSessionBrowserTab,
        closeTab,
      });
    },
  };
}

/** Capture successful native allocation before any post-invoke assertion or file transfer. */
export function captureBrowserNodeOpenCleanup(params: {
  method: string;
  path: string;
  body?: unknown;
  result: unknown;
  session?: BrowserSessionScope;
  profile?: string;
  route: Extract<BrowserSessionTabRoute, { kind: "node-proxy" }>;
}) {
  if (!params.session || params.method !== "POST") {
    return undefined;
  }
  const value =
    params.path === "/tabs/open"
      ? params.result
      : params.path === "/tabs/action" && asNullableRecord(params.body)?.action === "new"
        ? asNullableRecord(params.result)?.tab
        : undefined;
  const opened = readOpenedTab(value);
  const targetId = opened.targetId;
  const profile = opened.profile ?? params.profile;
  if (!targetId || !profile) {
    return undefined;
  }
  const identity = { ...params.session, targetId, profile, route: params.route };
  let association: VolatileSessionTab | undefined;
  let cleanup: Promise<void> | undefined;
  return {
    rememberAssociation: () => {
      association = resolveVolatile(identity)?.tab;
    },
    cleanup: () =>
      (cleanup ??= withoutBrowserRequestScope(async () => {
        // Removing the tab selector scope does not remove the original Gateway actor
        // authority. The captured route additionally verifies durable native ownership.
        const outcome = await params.route.closeTarget({
          targetId,
          profile,
          ownership: opened.ownership,
          session: params.session,
        });
        if (!["closed", "missing", "ownership-mismatch"].includes(outcome.status)) {
          throw new Error("Could not compensate the allocated node browser tab");
        }
        if (association) {
          deleteVolatileRegistrations([association]);
        }
      })),
  };
}

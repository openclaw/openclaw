import {
  asNullableRecord,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { z } from "zod";
import type { BrowserNodeTarget } from "../browser-node-routing.js";
import { getOptionalBrowserStateRuntime } from "../browser-runtime-state.js";
import { createBrowserToolSessionTabs } from "../browser-tool-session-tabs.js";

export const browserTabScopeSchema = z.strictObject({
  sessionKey: z.string().trim().min(1).max(512),
  referencedTabs: z
    .array(
      z
        .strictObject({
          target: z.enum(["host", "node"]),
          node: z.string().trim().min(1).max(256).optional(),
          profile: z.string().trim().min(1).optional(),
          targetId: z.string().trim().min(1),
        })
        .refine((tab) => tab.target === "node" || tab.node === undefined),
    )
    .max(64)
    .optional(),
});

/** Apply session membership only after the execution owner has completed the route. */
export async function applyBrowserRequestTabScope(params: {
  scope: z.infer<typeof browserTabScopeSchema>;
  method: string;
  path: string;
  body: unknown;
  result: unknown;
  nodeTarget?: BrowserNodeTarget;
  profile?: string;
  requestedProfile?: string;
  defaultProfile?: string;
  assertCurrent: () => void;
  closeTab: (targetId: string, profile?: string) => Promise<void>;
}): Promise<unknown> {
  params.assertCurrent();
  const listTabs = params.method === "GET" && params.path === "/tabs";
  const openTab = params.method === "POST" && params.path === "/tabs/open";
  const closeTab = params.method === "DELETE" && /^\/tabs\/[^/]+$/.test(params.path);
  const touchTab =
    params.method === "POST" && (params.path === "/navigate" || params.path === "/tabs/focus");
  if (!listTabs && !openTab && !closeTab && !touchTab) {
    return params.result;
  }
  const authority = {
    runtime: getOptionalBrowserStateRuntime() ?? undefined,
    assertCurrent: params.assertCurrent,
  };
  const registry = await import("../browser/session-tab-registry.js");
  const nodeRoute = params.nodeTarget
    ? (await import("../browser-node-proxy.js")).createBrowserNodeSessionTabRoute(params.nodeTarget)
    : undefined;
  params.assertCurrent();
  const route = nodeRoute ?? { kind: "browser-control" as const };
  const profile = normalizeOptionalLowercaseString(params.profile);
  if (listTabs) {
    const result = asNullableRecord(params.result);
    if (!Array.isArray(result?.tabs)) {
      return params.result;
    }
    const tabs = result.tabs.flatMap((value: unknown) => {
      const tab = asNullableRecord(value);
      const targetId = normalizeOptionalString(tab?.targetId);
      return targetId ? [{ value, targetId, tabId: normalizeOptionalString(tab?.tabId) }] : [];
    });
    const tracked = new Set(
      await registry.filterTrackedSessionBrowserTabs({
        sessionKey: params.scope.sessionKey,
        route,
        profile,
        tabs,
        authority,
      }),
    );
    params.assertCurrent();
    const referenced = new Set(
      (params.scope.referencedTabs ?? [])
        .filter((tab) => {
          if (
            nodeRoute
              ? tab.target !== "node" || tab.node !== nodeRoute.nodeId
              : tab.target !== "host"
          ) {
            return false;
          }
          const referenceProfile = normalizeOptionalLowercaseString(
            tab.profile ??
              (nodeRoute
                ? !params.requestedProfile
                  ? profile
                  : undefined
                : params.defaultProfile),
          );
          return referenceProfile === profile;
        })
        .map((tab) => tab.targetId),
    );
    return {
      ...result,
      tabs: tabs
        .filter(
          (tab) =>
            tracked.has(tab) ||
            referenced.has(tab.targetId) ||
            Boolean(tab.tabId && referenced.has(tab.tabId)),
        )
        .map((tab) => tab.value),
    };
  }

  const sessionTabs = createBrowserToolSessionTabs({
    sessionKey: params.scope.sessionKey,
    requestedProfile: params.requestedProfile,
    defaultProfile: params.defaultProfile ?? "",
    nodeRoute,
    routeProfile: () => params.profile,
    registry,
    authority,
  });
  if (openTab) {
    await sessionTabs.trackOpened(params.result, params.closeTab);
  } else if (closeTab) {
    await sessionTabs.untrack(decodeURIComponent(params.path.slice(6)));
  } else if (touchTab) {
    await sessionTabs.touch(normalizeOptionalString(asNullableRecord(params.body)?.targetId));
  }
  params.assertCurrent();
  return params.result;
}

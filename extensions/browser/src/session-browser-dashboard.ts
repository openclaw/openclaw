import { createBrowserControlContext, getBrowserControlState } from "./browser-control-state.js";
import {
  readBrowserDashboardDefinition,
  sameBrowserDashboardDefinition,
} from "./browser-dashboard-definition.js";
import type {
  BrowserDashboardDefinition,
  BrowserDashboardRequest,
  BrowserDashboardResponse,
  SessionBrowserAuthority,
  SessionBrowserDashboard,
} from "./browser-dashboard.types.js";
import { getBrowserStateRuntime, getOptionalBrowserStateRuntime } from "./browser-runtime-state.js";
import { resolveCdpControlPolicy } from "./browser/cdp-reachability-policy.js";
import { isLocalManagedProfile } from "./browser/config.js";
import { startBrowserControlServiceFromConfig } from "./browser/control-service.js";
import { getPwAiModule } from "./browser/pw-ai-module.js";
import { browserNavigationPolicyForProfile } from "./browser/routes/agent.shared.js";
import {
  getProfileLifecycle,
  isProfileGenerationCurrent,
} from "./browser/server-context.lifecycle.js";

type SessionBorrow = ReturnType<SessionBrowserAuthority["retainSession"]>;
const MAX_SESSION_DASHBOARDS = 64;

function keyFor(definition: BrowserDashboardDefinition) {
  return JSON.stringify([definition.agentId, definition.sessionKey, definition.instanceId]);
}

function response(resource: SessionBrowserDashboard): BrowserDashboardResponse {
  const definition = resource.definition;
  return {
    sessionKey: definition.sessionKey,
    name: definition.name,
    instanceId: definition.instanceId,
    revision: definition.revision,
    url: definition.url,
    title: definition.title,
    paused: resource.paused,
    stopping: false,
    ...(resource.page
      ? {
          browserTab: {
            target: "host" as const,
            profile: definition.profile,
            targetId: resource.page.targetId,
          },
        }
      : {}),
  };
}

async function createResource(
  definition: BrowserDashboardDefinition,
  authority: SessionBrowserAuthority,
  signal: AbortSignal | undefined,
  operation: "inspect" | "open" | "stop",
): Promise<SessionBrowserDashboard> {
  const runtime = getBrowserStateRuntime();
  const resources = (runtime.sessionDashboards ??= new Map());
  if (resources.size >= MAX_SESSION_DASHBOARDS) {
    throw new Error(
      "The Gateway has reached its isolated dashboard limit. Remove an unused browser widget and retry.",
    );
  }
  const session: SessionBorrow = authority.retainSession();
  const controller = new AbortController();
  const key = keyFor(definition);
  let retired = false;
  let definitionPending = false;
  let definitionEpoch = 0;
  let page: SessionBrowserDashboard["page"];
  let assertProfileCurrent: (() => void) | undefined;
  let removeProfileAbort: (() => void) | undefined;
  let closing: Promise<void> | undefined;
  const close = () => {
    retired = true;
    controller.abort(new Error("The isolated browser dashboard was retired."));
    session.signal.removeEventListener("abort", onSessionAbort);
    session.release();
    removeProfileAbort?.();
    removeProfileAbort = undefined;
    if (!closing) {
      closing = (async () => {
        await page?.close();
        if (resources.get(key) === resource) {
          resources.delete(key);
        }
      })().catch((error: unknown) => {
        closing = undefined;
        throw error;
      });
    }
    return closing;
  };
  const assertCurrent = () => {
    session.assertCurrent();
    if (retired || getOptionalBrowserStateRuntime() !== runtime || (page && !page.isCurrent())) {
      throw new Error("The isolated browser context is no longer available. Reopen the dashboard.");
    }
    assertProfileCurrent?.();
    if (definitionPending) {
      throw new Error("The dashboard definition changed. Refresh the dashboard before continuing.");
    }
  };
  const resource: SessionBrowserDashboard = {
    definition,
    session: authority.target,
    paused: operation === "stop",
    signal: controller.signal,
    assertCurrent,
    assertDefinitionCurrent: async () => {
      session.assertCurrent();
      const epoch = definitionEpoch;
      const current = await readBrowserDashboardDefinition(
        definition,
        getBrowserControlState()?.resolved.defaultProfile,
      );
      session.assertCurrent();
      if (epoch !== definitionEpoch) {
        throw new Error("The dashboard changed during verification. Retry the operation.");
      }
      if (!sameBrowserDashboardDefinition(definition, current)) {
        await close();
        throw new Error("The dashboard was removed or replaced. Open its current definition.");
      }
      definitionPending = false;
      assertCurrent();
    },
    definitionChanged: () => {
      definitionPending = true;
      definitionEpoch += 1;
    },
    close,
  };
  const onSessionAbort = () => {
    void close().catch(() => {});
  };
  session.signal.addEventListener("abort", onSessionAbort, { once: true });
  resources.set(key, resource);
  try {
    authority.assertCurrent();
    signal?.throwIfAborted();
    if (operation === "open") {
      if (!(await startBrowserControlServiceFromConfig())) {
        throw new Error("Browser control is unavailable on this Gateway.");
      }
      authority.assertCurrent();
      signal?.throwIfAborted();
      const context = createBrowserControlContext();
      if (definition.profile !== context.state().resolved.defaultProfile) {
        throw new Error(
          "Isolated session dashboards use the configured default managed profile. Remove the widget's custom profile before reopening it.",
        );
      }
      const profileContext = context.forProfile(definition.profile);
      if (!isLocalManagedProfile(profileContext.profile)) {
        throw new Error(
          "Isolated session dashboards require a local managed browser profile. Attached, extension and remote profiles are unsupported.",
        );
      }
      await profileContext.ensureBrowserAvailable({ signal });
      authority.assertCurrent();
      signal?.throwIfAborted();
      const state = getBrowserControlState();
      const profile = state?.profiles.get(definition.profile);
      if (!state || !profile) {
        throw new Error("Browser profile is unavailable.");
      }
      const lifecycle = getProfileLifecycle(profile);
      const generation = lifecycle.generation;
      const configRevision = lifecycle.configRevision;
      assertProfileCurrent = () => {
        if (
          getBrowserControlState() !== state ||
          state.profiles.get(definition.profile) !== profile ||
          !isProfileGenerationCurrent({ state, runtime: profile, generation, configRevision })
        ) {
          throw new Error("The browser profile changed. Reopen the dashboard.");
        }
      };
      const onProfileAbort = () => {
        void close().catch(() => {});
      };
      lifecycle.controller.signal.addEventListener("abort", onProfileAbort, { once: true });
      removeProfileAbort = () =>
        lifecycle.controller.signal.removeEventListener("abort", onProfileAbort);
      const playwright = await getPwAiModule({ mode: "strict" });
      authority.assertCurrent();
      assertProfileCurrent();
      if (!playwright) {
        throw new Error("Isolated session dashboards require Playwright in this Gateway build.");
      }
      page = await playwright.createPageViaPlaywright({
        cdpUrl: profileContext.profile.cdpUrl,
        url: definition.url,
        isolatedContext: true,
        assertCurrent: () => {
          authority.assertCurrent();
          assertCurrent();
        },
        ...browserNavigationPolicyForProfile(context, profileContext),
        cdpPolicy: resolveCdpControlPolicy(profileContext.profile, state.resolved.ssrfPolicy),
        signal: signal
          ? AbortSignal.any([signal, session.signal, controller.signal])
          : AbortSignal.any([session.signal, controller.signal]),
      });
      resource.page = page;
      if (retired) {
        await page.close();
        throw new Error("The session browser was retired during startup.");
      }
      authority.assertCurrent();
      signal?.throwIfAborted();
      await resource.assertDefinitionCurrent();
      authority.assertCurrent();
    }
    assertCurrent();
    return resource;
  } catch (error) {
    await close();
    throw error;
  }
}

/** Same-widget requests serialize before allocation, so competing viewers never create shared-profile tabs. */
export async function accessSessionBrowserDashboard(
  request: BrowserDashboardRequest,
  authority: SessionBrowserAuthority,
  options: { operation: "inspect" | "open" | "stop"; resume?: boolean; signal?: AbortSignal },
): Promise<{
  response: BrowserDashboardResponse;
  resource: SessionBrowserDashboard;
}> {
  if (authority.sandboxRequired) {
    throw new Error(
      "This session requires a sandbox. The Gateway's isolated browser context does not provide a sandbox backend; ask an operator for a supported sandbox browser.",
    );
  }
  authority.assertCurrent();
  options.signal?.throwIfAborted();
  if (!(await startBrowserControlServiceFromConfig())) {
    throw new Error("Browser control is unavailable on this Gateway.");
  }
  authority.assertCurrent();
  const definition = await readBrowserDashboardDefinition(
    request,
    getBrowserControlState()?.resolved.defaultProfile,
  );
  authority.assertCurrent();
  options.signal?.throwIfAborted();
  if (
    !definition ||
    definition.sessionKey !== authority.target.sessionKey ||
    definition.agentId !== authority.target.agentId
  ) {
    throw new Error("The browser dashboard is missing, invalid or belongs to a different session.");
  }
  const runtime = getBrowserStateRuntime();
  const key = keyFor(definition);
  const operationKey = `session:${key}`;
  const previous = runtime.dashboardOperations.get(operationKey)?.promise;
  const promise = (async () => {
    await previous?.catch(() => {});
    authority.assertCurrent();
    options.signal?.throwIfAborted();
    if (getOptionalBrowserStateRuntime() !== runtime) {
      throw new Error("Browser runtime changed.");
    }
    // The first read selects the queue, not authority to replace its resource.
    // A delayed reader must not close a newer collaborator's context or visit an old URL.
    const currentDefinition = await readBrowserDashboardDefinition(
      { ...request, instanceId: definition.instanceId },
      getBrowserControlState()?.resolved.defaultProfile,
    );
    authority.assertCurrent();
    options.signal?.throwIfAborted();
    if (getOptionalBrowserStateRuntime() !== runtime) {
      throw new Error("Browser runtime changed.");
    }
    if (!sameBrowserDashboardDefinition(definition, currentDefinition)) {
      throw new Error("The dashboard changed before this operation. Open its current definition.");
    }
    let resource = runtime.sessionDashboards?.get(key);
    if (
      resource &&
      (!sameBrowserDashboardDefinition(resource.definition, definition) ||
        resource.session.sessionId !== authority.target.sessionId ||
        resource.session.lifecycleRevision !== authority.target.lifecycleRevision)
    ) {
      await resource.close();
      resource = undefined;
    }
    if (resource) {
      try {
        await resource.assertDefinitionCurrent();
      } catch (error) {
        if (resource.page && !resource.page.isCurrent()) {
          await resource.close();
        }
        throw error;
      }
      authority.assertCurrent();
    }
    if (
      resource &&
      (options.operation === "stop" ||
        (options.operation === "open" &&
          ((options.resume && resource.paused) || (!resource.page && !resource.paused))))
    ) {
      await resource.close();
      resource = undefined;
      authority.assertCurrent();
    }
    if (!resource) {
      resource = await createResource(definition, authority, options.signal, options.operation);
    }
    authority.assertCurrent();
    resource.assertCurrent();
    return { response: response(resource), resource };
  })();
  const operation = { promise };
  runtime.dashboardOperations.set(operationKey, operation);
  try {
    return await promise;
  } finally {
    if (runtime.dashboardOperations.get(operationKey) === operation) {
      runtime.dashboardOperations.delete(operationKey);
    }
  }
}

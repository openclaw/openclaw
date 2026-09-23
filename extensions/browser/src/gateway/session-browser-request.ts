import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { z } from "zod";
import { createBrowserControlContext } from "../browser-control-state.js";
import { applyBrowserTabToolBinding } from "../browser-tool-binding.js";
import { createBrowserRouteDispatcher } from "../browser/routes/dispatcher.js";
import { ErrorCodes, errorShape, withTimeout, type GatewayRequestHandlers } from "../core-api.js";
import { accessSessionBrowserDashboard } from "../session-browser-dashboard.js";

const identitySchema = z.strictObject({
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  instanceId: z.string().min(1).optional(),
  sessionKey: z.string().optional(),
  agentId: z.string().optional(),
  resume: z.boolean().optional(),
});
const requestSchema = z.strictObject({
  sessionKey: z.string().min(1),
  agentId: z.string().min(1).optional(),
  method: z.enum(["GET", "POST", "DELETE"]),
  path: z.string(),
  timeoutMs: z.number().finite().positive().optional(),
  dashboard: identitySchema.optional(),
  query: z.record(z.string(), z.unknown()).optional(),
  body: z.record(z.string(), z.unknown()).optional(),
});
const routes = new Set([
  "GET /tabs",
  "GET /snapshot",
  "POST /screenshot",
  "POST /navigate",
  "POST /tabs/focus",
  "POST /act",
  "POST /screencast",
]);
const actions = new Set([
  "click",
  "clickCoords",
  "type",
  "press",
  "hover",
  "scrollIntoView",
  "drag",
  "select",
  "fill",
  "resize",
  "wait",
  "evaluate",
  "insertText",
]);
const selectors = ["targetId", "profile", "target", "node"];

/** Closed session route: it never forwards profile, tab, file, cookie or host administration. */
export const handleSessionBrowserGatewayRequest: GatewayRequestHandlers[string] = async (
  options,
) => {
  const { respond, sessionAccessAuthority: authority, signal: requestSignal, client } = options;
  try {
    if (!authority) {
      throw new Error("Session browser access requires Gateway session admission.");
    }
    const params = requestSchema.parse(options.params);
    await withTimeout(
      async (timeoutSignal) => {
        const signal =
          timeoutSignal && requestSignal
            ? AbortSignal.any([timeoutSignal, requestSignal])
            : (timeoutSignal ?? requestSignal);
        const identity = identitySchema.parse(
          params.dashboard ?? (params.method === "GET" ? params.query : params.body),
        );
        if (
          (identity.sessionKey !== undefined && identity.sessionKey !== params.sessionKey) ||
          (identity.agentId !== undefined && identity.agentId !== authority.target.agentId)
        ) {
          throw new Error("Dashboard identity must match the admitted session.");
        }
        const assertInvocation = () => {
          signal?.throwIfAborted();
          authority.assertCurrent();
        };
        assertInvocation();
        const dashboard = params.path === "/dashboard";
        if (!dashboard && !routes.has(`${params.method} ${params.path}`)) {
          throw new Error("This operation is unavailable in an isolated session browser.");
        }
        if (
          !dashboard &&
          [params.query, params.body].some(
            (record) => record && selectors.some((key) => Object.hasOwn(record, key)),
          )
        ) {
          throw new Error("Session browser requests cannot select a browser profile or target.");
        }
        if (
          params.path === "/act" &&
          (typeof params.body?.kind !== "string" || !actions.has(params.body.kind))
        ) {
          throw new Error("This action is unavailable in an isolated session browser.");
        }
        const { response, resource } = await accessSessionBrowserDashboard(
          {
            sessionKey: params.sessionKey,
            agentId: authority.target.agentId,
            name: identity.name,
            instanceId: identity.instanceId,
          },
          authority,
          {
            operation: dashboard
              ? params.method === "POST"
                ? "open"
                : params.method === "DELETE"
                  ? "stop"
                  : "inspect"
              : "inspect",
            resume: identity.resume ?? params.body?.resume === true,
            signal,
          },
        );
        assertInvocation();
        if (dashboard) {
          respond(true, response);
          return;
        }
        const tab = response.browserTab;
        if (!tab || response.paused) {
          throw new Error(
            "The session browser is paused or unavailable. Resume the dashboard first.",
          );
        }
        const context = createBrowserControlContext();
        const assertCurrent = async () => {
          assertInvocation();
          resource.assertCurrent();
        };
        await assertCurrent();
        if (params.path === "/tabs") {
          const tabs = await context.forProfile(tab.profile).listTabs({ signal });
          await assertCurrent();
          respond(true, {
            running: true,
            tabs: tabs.filter((entry) => entry.targetId === tab.targetId),
          });
          return;
        }
        const binding = { kind: "tab" as const, tabId: 0, ...tab };
        const query = {
          ...applyBrowserTabToolBinding(params.query ?? {}, binding),
          managedOnly: true,
        };
        const body = applyBrowserTabToolBinding(params.body ?? {}, binding);
        const result = await createBrowserRouteDispatcher(context).dispatch({
          method: params.method,
          path: params.path,
          query,
          body,
          signal,
          assertCurrent,
          screencastAuthority: {
            signal: resource.signal,
            assertCurrent: resource.assertCurrent,
            retainRequester: () => {
              assertInvocation();
              resource.assertCurrent();
              const borrow = authority.retain();
              const viewerSignal = AbortSignal.any([
                borrow.signal,
                resource.signal,
                ...(client?.connectionSignal ? [client.connectionSignal] : []),
              ]);
              return {
                signal: viewerSignal,
                release: borrow.release,
                isCurrent: () => {
                  try {
                    viewerSignal.throwIfAborted();
                    borrow.assertCurrent();
                    resource.assertCurrent();
                    return client?.invalidated !== true;
                  } catch {
                    return false;
                  }
                },
              };
            },
          },
        });
        await assertCurrent();
        if (result.status >= 400) {
          const payload = asNullableRecord(result.body);
          respond(
            false,
            undefined,
            errorShape(
              result.status >= 500 ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
              typeof payload?.error === "string"
                ? payload.error
                : "Session browser request failed.",
              { details: result.body },
            ),
          );
          return;
        }
        respond(true, result.body);
      },
      params.timeoutMs,
      "session browser request",
    );
  } catch (error) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        error instanceof Error ? error.message : String(error),
      ),
    );
  }
};

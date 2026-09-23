import { parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { z } from "zod";
import type {
  BrowserDashboardDefinition,
  BrowserDashboardIdentity,
  BrowserDashboardRequest,
} from "./browser-dashboard.types.js";
import { getBrowserStateRuntime } from "./browser-runtime-state.js";

const BROWSER_DASHBOARD_WIDGET_KIND = "browser:dashboard";

const dashboardUrl = z
  .string()
  .min(1)
  .max(4096)
  .transform((value, ctx) => {
    const url = URL.parse(value);
    if (
      !url ||
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.href.length > 4096
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Browser dashboard URL must be HTTP(S), without embedded credentials, and at most 4096 characters",
      });
      return z.NEVER;
    }
    return url.href;
  });

const browserDashboardPropsSchema = z.strictObject({
  url: dashboardUrl,
  profile: z.string().trim().min(1).max(128).optional(),
});

const boardSnapshotSchema = z.object({
  sessionKey: z.string().min(1),
  widgets: z.array(
    z.object({
      name: z.string(),
      instanceId: z.string().optional(),
      revision: z.number().int().positive(),
      contentKind: z.string(),
      pluginKind: z.string().optional(),
      props: z.unknown().optional(),
      title: z.string().optional(),
    }),
  ),
});

/** Resolve the current board instance; a saved browser target is never authority. */
export async function readBrowserDashboardDefinition(
  request: BrowserDashboardRequest,
): Promise<BrowserDashboardDefinition | undefined> {
  const runtime = getBrowserStateRuntime();
  if (!runtime.gateway) {
    throw new Error("Browser dashboards require an active Gateway");
  }
  const snapshot = boardSnapshotSchema.parse(
    await runtime.gateway.request("board.get", {
      sessionKey: request.sessionKey,
      ...(request.agentId ? { agentId: request.agentId } : {}),
    }),
  );
  if (getBrowserStateRuntime() !== runtime) {
    throw new Error("Browser dashboard runtime changed");
  }
  const agentId = parseAgentSessionKey(snapshot.sessionKey)?.agentId;
  if (!agentId) {
    throw new Error("Board did not return a canonical agent-scoped session identity");
  }
  const widget = snapshot.widgets.find((entry) => entry.name === request.name);
  if (
    !widget ||
    widget.contentKind !== "plugin" ||
    widget.pluginKind !== BROWSER_DASHBOARD_WIDGET_KIND ||
    !widget.instanceId ||
    (request.instanceId && request.instanceId !== widget.instanceId)
  ) {
    return undefined;
  }
  const parsedProps = browserDashboardPropsSchema.safeParse(widget.props);
  // A successfully read but unusable definition no longer owns its old tab.
  // Transport and snapshot failures above still retain ownership for recovery.
  if (!parsedProps.success) {
    return undefined;
  }
  const props = parsedProps.data;
  return {
    sessionKey: snapshot.sessionKey,
    agentId,
    name: widget.name,
    instanceId: widget.instanceId,
    revision: widget.revision,
    ...(widget.title ? { title: widget.title } : {}),
    url: props.url,
    profile: props.profile ?? "openclaw",
  };
}

export function sameBrowserDashboardDefinition(
  left: BrowserDashboardIdentity,
  right: BrowserDashboardIdentity | undefined,
): boolean {
  return Boolean(
    right &&
    left.sessionKey === right.sessionKey &&
    left.agentId === right.agentId &&
    left.instanceId === right.instanceId &&
    left.name === right.name &&
    left.url === right.url &&
    left.profile === right.profile,
  );
}

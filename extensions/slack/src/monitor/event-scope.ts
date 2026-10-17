import type { WebClient, WebClientOptions } from "@slack/web-api";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getSlackListenerWriteClient } from "../client.js";
import type { SlackInstallationIdentity } from "./enterprise-install.js";

export type SlackEventScope = Readonly<{
  teamId: string;
  // Keep Bolt's exact listener client for reads and native event identity.
  client: WebClient;
  // Writes cannot inherit Bolt's retries: Slack may accept a request before
  // its response is lost. Preserve the listener token, transport and team scope.
  writeClient?: WebClient;
}>;

type SlackEventScopeDropReason =
  | "enterprise_event_for_workspace_account"
  | "wrong_app"
  | "not_enterprise_install"
  | "missing_enterprise_id"
  | "wrong_enterprise"
  | "missing_team_id"
  | "missing_listener_client";

export function resolveSlackMonitorEventScope(params: {
  ctx: {
    installationIdentity: SlackInstallationIdentity;
    app: { webClientOptions?: WebClientOptions };
  };
  body: unknown;
  context?: {
    isEnterpriseInstall?: unknown;
    enterpriseId?: unknown;
    teamId?: unknown;
  };
  client?: WebClient;
  onDrop?: (reason: SlackEventScopeDropReason) => void;
}): SlackEventScope | null | undefined {
  const identity = params.ctx.installationIdentity;
  const clientOptions = params.ctx.app.webClientOptions;
  const onDrop =
    params.onDrop ?? ((reason) => logVerbose(`slack: drop listener event (${reason})`));
  const drop = (reason: SlackEventScopeDropReason) => {
    onDrop(reason);
    return null;
  };
  const context = params.context ?? {};
  if (identity.kind !== "enterprise") {
    return context.isEnterpriseInstall === true
      ? drop("enterprise_event_for_workspace_account")
      : undefined;
  }
  const body =
    params.body && typeof params.body === "object" ? (params.body as { api_app_id?: unknown }) : {};
  const apiAppId = normalizeOptionalString(body.api_app_id);
  if (apiAppId && identity.apiAppId && apiAppId !== identity.apiAppId) {
    return drop("wrong_app");
  }
  if (context.isEnterpriseInstall !== true) {
    return drop("not_enterprise_install");
  }
  const enterpriseId = normalizeOptionalString(context.enterpriseId);
  if (!enterpriseId) {
    return drop("missing_enterprise_id");
  }
  if (enterpriseId !== identity.enterpriseId) {
    return drop("wrong_enterprise");
  }
  const teamId = normalizeOptionalString(context.teamId);
  if (!teamId) {
    return drop("missing_team_id");
  }
  if (!params.client) {
    return drop("missing_listener_client");
  }
  const writeClient = getSlackListenerWriteClient({
    listenerClient: params.client,
    teamId,
    clientOptions,
  });
  return {
    teamId,
    client: params.client,
    ...(writeClient ? { writeClient } : {}),
  };
}

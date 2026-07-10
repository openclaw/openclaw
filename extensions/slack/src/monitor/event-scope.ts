// Slack plugin module validates non-serializable per-event Enterprise Grid scope.
import type { WebClient, WebClientOptions } from "@slack/web-api";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getSlackListenerDeliveryClient } from "../client.js";
import type { SlackInstallationIdentity } from "./enterprise-install.js";

export type SlackEventScope = {
  apiAppId: string;
  enterpriseId: string;
  teamId: string;
  isEnterpriseInstall: true;
  // Bolt's exact pooled client retains normal retries for listener reads.
  client: WebClient;
  // One-shot sends use a distinct zero-retry client with the same token, transport, and team scope.
  deliveryClient: WebClient;
};

export type SlackEventScopeResolution =
  | { ok: true; scope?: SlackEventScope }
  | {
      ok: false;
      reason:
        | "enterprise_event_for_workspace_account"
        | "missing_api_app_id"
        | "wrong_app"
        | "not_enterprise_install"
        | "missing_enterprise_id"
        | "wrong_enterprise"
        | "missing_team_id"
        | "invalid_team_id"
        | "missing_listener_client"
        | "missing_listener_token"
        | "listener_team_mismatch";
    };

export function resolveSlackEventScope(params: {
  identity: SlackInstallationIdentity;
  body: unknown;
  context?: {
    isEnterpriseInstall?: unknown;
    enterpriseId?: unknown;
    teamId?: unknown;
  };
  client?: WebClient;
  clientOptions?: WebClientOptions;
}): SlackEventScopeResolution {
  const context = params.context ?? {};
  if (params.identity.kind !== "enterprise") {
    return context.isEnterpriseInstall === true
      ? { ok: false, reason: "enterprise_event_for_workspace_account" }
      : { ok: true };
  }
  const body =
    params.body && typeof params.body === "object" ? (params.body as { api_app_id?: unknown }) : {};
  const apiAppId = normalizeOptionalString(body.api_app_id);
  if (!apiAppId) {
    return { ok: false, reason: "missing_api_app_id" };
  }
  if (params.identity.apiAppId && apiAppId !== params.identity.apiAppId) {
    return { ok: false, reason: "wrong_app" };
  }
  if (context.isEnterpriseInstall !== true) {
    return { ok: false, reason: "not_enterprise_install" };
  }
  const enterpriseId = normalizeOptionalString(context.enterpriseId);
  if (!enterpriseId) {
    return { ok: false, reason: "missing_enterprise_id" };
  }
  if (enterpriseId !== params.identity.enterpriseId) {
    return { ok: false, reason: "wrong_enterprise" };
  }
  const teamId = normalizeOptionalString(context.teamId);
  if (!teamId) {
    return { ok: false, reason: "missing_team_id" };
  }
  if (!/^T[A-Z0-9]+$/i.test(teamId)) {
    return { ok: false, reason: "invalid_team_id" };
  }
  if (!params.client) {
    return { ok: false, reason: "missing_listener_client" };
  }
  if (!normalizeOptionalString(params.client.token)) {
    return { ok: false, reason: "missing_listener_token" };
  }
  const deliveryClient = getSlackListenerDeliveryClient({
    listenerClient: params.client,
    teamId,
    clientOptions: params.clientOptions,
  });
  if (!deliveryClient) {
    return { ok: false, reason: "listener_team_mismatch" };
  }
  return {
    ok: true,
    scope: {
      apiAppId,
      enterpriseId,
      teamId,
      isEnterpriseInstall: true,
      client: params.client,
      deliveryClient,
    },
  };
}

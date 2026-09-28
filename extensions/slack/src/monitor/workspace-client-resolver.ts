import { type WebClientOptions, WebClient } from "@slack/web-api";
import { createSlackWebClient } from "../client.js";
import type { SlackInstallationIdentity } from "./enterprise-install.js";

export function createSlackWorkspaceClientResolver(params: {
  appClient: WebClient;
  token: string;
  clientOptions: WebClientOptions;
  installationIdentity: SlackInstallationIdentity;
}): (teamId?: string) => WebClient {
  if (params.installationIdentity.kind !== "enterprise") {
    return () => params.appClient;
  }
  const clients = new Map<string, WebClient>();
  return (rawTeamId?: string) => {
    const teamId = rawTeamId;
    if (!teamId || !/^T[A-Z0-9]+$/.test(teamId)) {
      throw new Error("Slack Enterprise Grid workspace client requires a valid teamId");
    }
    const cached = clients.get(teamId);
    if (cached) {
      return cached;
    }
    const client = createSlackWebClient(params.token, {
      ...params.clientOptions,
      teamId,
    });
    clients.set(teamId, client);
    return client;
  };
}

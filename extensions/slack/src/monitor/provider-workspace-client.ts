import type { FetchFunction, WebClient, WebClientOptions } from "@slack/web-api";
import { createSlackWebClient } from "../client.js";
import type { SlackInstallationIdentity } from "./enterprise-install.js";

export function withSlackPresenceLifecycleSignal(
  fetchImpl: FetchFunction,
  lifecycleSignal: AbortSignal,
): FetchFunction {
  return async (input, init) =>
    await fetchImpl(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, lifecycleSignal]) : lifecycleSignal,
    });
}

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
  return (teamId?: string) => {
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

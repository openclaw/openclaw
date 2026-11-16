import type { App } from "@microsoft/teams.apps";
import type { RequestInterceptor } from "@microsoft/teams.common/http";
import { vi } from "vitest";

export function createSigninEvent(
  name: "signin/tokenExchange" | "signin/verifyState" = "signin/tokenExchange",
  senderId = "29:user",
) {
  const serviceUrl = "https://smba.trafficmanager.net/teams";
  const body = {
    type: "invoke",
    name,
    id: `invoke-${name}`,
    channelId: "msteams",
    serviceUrl,
    from: { id: senderId, aadObjectId: "aad-user" },
    recipient: { id: "fixture-bot" },
    conversation: {
      id: "fixture-conversation",
      conversationType: "personal",
      tenantId: "fixture-tenant",
    },
    value:
      name === "signin/tokenExchange"
        ? { id: "exchange-id", connectionName: "graph", token: "fixture-user-token" }
        : { state: "fixture-state" },
  };
  return {
    body,
    token: {
      appId: "fixture-bot",
      from: "bot",
      fromId: "fixture-bot",
      serviceUrl,
      isExpired: () => false,
      toString: () => "fixture-inbound-token",
    },
  } satisfies Parameters<App["process"]>[0];
}

export async function createNativeSsoProcessor() {
  const { App: NativeApp } =
    await vi.importActual<typeof import("@microsoft/teams.apps")>("@microsoft/teams.apps");
  const requests: Array<{
    method?: string;
    path: string;
    query: Record<string, string>;
    data: unknown;
  }> = [];
  const botToken = [
    { alg: "none", typ: "JWT" },
    { appid: "fixture-bot", tid: "fixture-tenant" },
  ]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .concat("fixture")
    .join(".");
  const intercept: RequestInterceptor<unknown> = ({ config }) => {
    config.adapter = async (request) => {
      const url = new URL(request.url!);
      if (
        url.origin !== "https://token.botframework.com" ||
        (url.pathname !== "/api/usertoken/GetToken" && url.pathname !== "/api/usertoken/exchange")
      ) {
        throw new Error(`Unexpected Teams SDK request: ${url}`);
      }
      requests.push({
        method: request.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        data: typeof request.data === "string" ? JSON.parse(request.data) : request.data,
      });
      return {
        data:
          url.pathname.endsWith("/exchange") || url.searchParams.has("code")
            ? {
                channelId: "msteams",
                connectionName: "graph",
                token: "delegated-graph-token",
                expiration: "2030-01-01T00:00:00Z",
              }
            : {},
        status: 200,
        statusText: "OK",
        headers: {},
        config: request,
      };
    };
    return config;
  };
  const app = new NativeApp({
    clientId: "fixture-bot",
    clientSecret: "",
    tenantId: "fixture-tenant",
    token: async () => botToken,
    oauth: { defaultConnectionName: "graph" },
    apiClientSettings: { oauthUrl: "https://token.botframework.com" },
    client: { interceptors: [{ request: intercept }] },
  });
  return { app, requests };
}

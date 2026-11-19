import type { App } from "@microsoft/teams.apps";

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

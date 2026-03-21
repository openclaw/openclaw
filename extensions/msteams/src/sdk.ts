import type { MSTeamsAdapter } from "./messenger.js";
import type { MSTeamsCredentials } from "./token.js";
import { buildUserAgent } from "./user-agent.js";

/**
 * Resolved Teams SDK modules loaded lazily to avoid importing when the
 * provider is disabled.
 */
export type MSTeamsTeamsSdk = {
  App: typeof import("@microsoft/teams.apps").App;
  Client: typeof import("@microsoft/teams.api").Client;
};

/**
 * A Teams SDK App instance used for token management and proactive messaging.
 */
export type MSTeamsApp = InstanceType<MSTeamsTeamsSdk["App"]>;

/**
 * Token provider compatible with the existing codebase, wrapping the Teams
 * SDK App's token methods.
 */
export type MSTeamsTokenProvider = {
  getAccessToken: (scope: string) => Promise<string>;
};

export async function loadMSTeamsSdk(): Promise<MSTeamsTeamsSdk> {
  const [appsModule, apiModule] = await Promise.all([
    import("@microsoft/teams.apps"),
    import("@microsoft/teams.api"),
  ]);
  return {
    App: appsModule.App,
    Client: apiModule.Client,
  };
}

/**
 * Create a Teams SDK App instance from credentials. The App manages token
 * acquisition, JWT validation, and the HTTP server lifecycle.
 *
 * This replaces the previous CloudAdapter + MsalTokenProvider + authorizeJWT
 * from @microsoft/agents-hosting.
 */
export function createMSTeamsApp(creds: MSTeamsCredentials, sdk: MSTeamsTeamsSdk): MSTeamsApp {
  return new sdk.App({
    clientId: creds.appId,
    clientSecret: creds.appPassword,
    tenantId: creds.tenantId,
  });
}

/**
 * Build a token provider that uses the Teams SDK App for token acquisition.
 */
export function createMSTeamsTokenProvider(app: MSTeamsApp): MSTeamsTokenProvider {
  return {
    async getAccessToken(scope: string): Promise<string> {
      if (scope.includes("graph.microsoft.com")) {
        const token = await (
          app as unknown as { getAppGraphToken(): Promise<{ value?: string } | null> }
        ).getAppGraphToken();
        return token?.value ?? "";
      }
      const token = await (
        app as unknown as { getBotToken(): Promise<{ value?: string } | null> }
      ).getBotToken();
      return token?.value ?? "";
    },
  };
}

/**
 * Build a CloudAdapter-compatible adapter using the Teams SDK REST client.
 *
 * This replaces the previous CloudAdapter from @microsoft/agents-hosting.
 * For incoming requests: the App's HttpPlugin handles JWT validation.
 * For proactive sends: uses the Bot Framework REST API via
 * @microsoft/teams.api Client.
 */
export function createMSTeamsAdapter(app: MSTeamsApp, sdk: MSTeamsTeamsSdk): MSTeamsAdapter {
  return {
    async continueConversation(_appId, reference, logic) {
      const token = await (
        app as unknown as { getBotToken(): Promise<{ value?: string } | null> }
      ).getBotToken();
      const tokenValue = token?.value;

      const serviceUrl = reference.serviceUrl;
      if (!serviceUrl) {
        throw new Error("Missing serviceUrl in conversation reference");
      }

      const conversationId = reference.conversation?.id;
      if (!conversationId) {
        throw new Error("Missing conversation.id in conversation reference");
      }

      // Build a send context that uses the Bot Framework REST API
      const apiClient = new sdk.Client(serviceUrl, {
        token: () => (tokenValue ? { value: tokenValue } : undefined),
        headers: { "User-Agent": buildUserAgent() },
      } as Record<string, unknown>);

      const sendContext = {
        async sendActivity(textOrActivity: string | object): Promise<unknown> {
          const activity =
            typeof textOrActivity === "string"
              ? ({ type: "message", text: textOrActivity } as Record<string, unknown>)
              : (textOrActivity as Record<string, unknown>);

          const response = await apiClient.conversations.activities(conversationId).create({
            type: "message",
            ...activity,
            from: reference.agent
              ? { id: reference.agent.id, name: reference.agent.name ?? "", role: "bot" }
              : undefined,
            conversation: {
              id: conversationId,
              conversationType: reference.conversation?.conversationType ?? "personal",
            },
          } as Parameters<
            typeof apiClient.conversations.activities extends (id: string) => {
              create: (a: infer T) => unknown;
            }
              ? never
              : never
          >[0]);

          return response;
        },
      };

      await logic(sendContext);
    },

    async process(req, res, logic) {
      const request = req as { body?: Record<string, unknown> };
      const response = res as {
        status: (code: number) => { send: (body?: unknown) => void };
      };

      try {
        const activity = request.body;
        const token = await (
          app as unknown as { getBotToken(): Promise<{ value?: string } | null> }
        ).getBotToken();
        const tokenValue = token?.value;
        const serviceUrl = activity?.serviceUrl as string | undefined;

        const context = {
          activity,
          async sendActivity(textOrActivity: string | object): Promise<unknown> {
            const msg =
              typeof textOrActivity === "string"
                ? ({ type: "message", text: textOrActivity } as Record<string, unknown>)
                : (textOrActivity as Record<string, unknown>);

            if (!serviceUrl) {
              return { id: "unknown" };
            }

            const convId = (activity?.conversation as Record<string, unknown>)?.id as
              | string
              | undefined;
            if (!convId) {
              return { id: "unknown" };
            }

            const apiClient = new sdk.Client(serviceUrl, {
              token: () => (tokenValue ? { value: tokenValue } : undefined),
              headers: { "User-Agent": buildUserAgent() },
            } as Record<string, unknown>);

            return await apiClient.conversations.activities(convId).create({
              type: "message",
              ...msg,
              conversation: { id: convId, conversationType: "personal" },
            } as Parameters<
              typeof apiClient.conversations.activities extends (id: string) => {
                create: (a: infer T) => unknown;
              }
                ? never
                : never
            >[0]);
          },
          async sendActivities(
            activities: Array<{ type: string } & Record<string, unknown>>,
          ): Promise<unknown> {
            const results = [];
            for (const act of activities) {
              results.push(await context.sendActivity(act));
            }
            return results;
          },
        };

        await logic(context);
        response.status(200).send();
      } catch (err) {
        response.status(500).send({ error: String(err) });
      }
    },
  };
}

export async function loadMSTeamsSdkWithAuth(creds: MSTeamsCredentials) {
  const sdk = await loadMSTeamsSdk();
  const app = createMSTeamsApp(creds, sdk);
  return { sdk, app };
}

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
          app as unknown as { getAppGraphToken(): Promise<{ toString(): string } | null> }
        ).getAppGraphToken();
        return token ? String(token) : "";
      }
      const token = await (
        app as unknown as { getBotToken(): Promise<{ toString(): string } | null> }
      ).getBotToken();
      return token ? String(token) : "";
    },
  };
}

/**
 * Update an existing activity via the Bot Framework REST API.
 * PUT /v3/conversations/{conversationId}/activities/{activityId}
 */
async function updateActivityViaRest(params: {
  serviceUrl: string;
  conversationId: string;
  activityId: string;
  activity: Record<string, unknown>;
  token?: string;
}): Promise<{ id?: string }> {
  const { serviceUrl, conversationId, activityId, activity, token } = params;
  const baseUrl = serviceUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": buildUserAgent(),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      type: "message",
      ...activity,
      id: activityId,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw Object.assign(new Error(`updateActivity failed: HTTP ${response.status} ${body}`), {
      statusCode: response.status,
    });
  }

  return await response.json().catch(() => ({ id: activityId }));
}

/**
 * Delete an existing activity via the Bot Framework REST API.
 * DELETE /v3/conversations/{conversationId}/activities/{activityId}
 */
async function deleteActivityViaRest(params: {
  serviceUrl: string;
  conversationId: string;
  activityId: string;
  token?: string;
}): Promise<void> {
  const { serviceUrl, conversationId, activityId, token } = params;
  const baseUrl = serviceUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/v3/conversations/${encodeURIComponent(conversationId)}/activities/${encodeURIComponent(activityId)}`;

  const headers: Record<string, string> = {
    "User-Agent": buildUserAgent(),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, {
    method: "DELETE",
    headers,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw Object.assign(new Error(`deleteActivity failed: HTTP ${response.status} ${body}`), {
      statusCode: response.status,
    });
  }
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
      const serviceUrl = reference.serviceUrl;
      if (!serviceUrl) {
        throw new Error("Missing serviceUrl in conversation reference");
      }

      const conversationId = reference.conversation?.id;
      if (!conversationId) {
        throw new Error("Missing conversation.id in conversation reference");
      }

      // Fetch a fresh token for each call via a token factory.
      // The SDK's App manages token caching/refresh internally.
      const getToken = async () => {
        const token = await (
          app as unknown as { getBotToken(): Promise<{ toString(): string } | null> }
        ).getBotToken();
        return token ? String(token) : undefined;
      };

      // Build a send context that uses the Bot Framework REST API.
      // Pass a token factory (not a cached value) so each request gets a fresh token.
      const apiClient = new sdk.Client(serviceUrl, {
        token: async () => (await getToken()) || undefined,
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
        async updateActivity(activityUpdate: object): Promise<{ id?: string } | void> {
          const nextActivity = activityUpdate as { id?: string } & Record<string, unknown>;
          const activityId = nextActivity.id;
          if (!activityId) {
            throw new Error("updateActivity requires an activity id");
          }
          // Bot Framework REST API: PUT /v3/conversations/{conversationId}/activities/{activityId}
          return await updateActivityViaRest({
            serviceUrl,
            conversationId,
            activityId,
            activity: nextActivity,
            token: await getToken(),
          });
        },
        async deleteActivity(activityId: string): Promise<void> {
          if (!activityId) {
            throw new Error("deleteActivity requires an activity id");
          }
          await deleteActivityViaRest({
            serviceUrl,
            conversationId,
            activityId,
            token: await getToken(),
          });
        },
      };

      await logic(sendContext);
    },

    async process(req, res, logic) {
      const request = req as { body?: Record<string, unknown> };
      const response = res as {
        status: (code: number) => { send: (body?: unknown) => void };
      };

      const activity = request.body;
      const isInvoke = (activity as Record<string, unknown>)?.type === "invoke";

      try {
        const serviceUrl = activity?.serviceUrl as string | undefined;

        // Token factory — fetches a fresh token for each API call.
        const getToken = async () => {
          const token = await (
            app as unknown as { getBotToken(): Promise<{ toString(): string } | null> }
          ).getBotToken();
          return token ? String(token) : undefined;
        };

        const context = {
          activity,
          async sendActivity(textOrActivity: string | object): Promise<unknown> {
            const msg =
              typeof textOrActivity === "string"
                ? ({ type: "message", text: textOrActivity } as Record<string, unknown>)
                : (textOrActivity as Record<string, unknown>);

            // invokeResponse is handled by the HTTP response from process(),
            // not by posting a new activity to Bot Framework.
            if (msg.type === "invokeResponse") {
              return { id: "invokeResponse" };
            }

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
              token: async () => (await getToken()) || undefined,
              headers: { "User-Agent": buildUserAgent() },
            } as Record<string, unknown>);

            const botId = (activity?.recipient as Record<string, unknown>)?.id as
              | string
              | undefined;
            const botName = (activity?.recipient as Record<string, unknown>)?.name as
              | string
              | undefined;
            const convType = (activity?.conversation as Record<string, unknown>)
              ?.conversationType as string | undefined;

            // Preserve replyToId for threaded replies (replyStyle: "thread")
            const inboundActivityId = (activity as Record<string, unknown>)?.id as
              | string
              | undefined;

            return await apiClient.conversations.activities(convId).create({
              type: "message",
              ...msg,
              from: botId ? { id: botId, name: botName ?? "", role: "bot" } : undefined,
              conversation: { id: convId, conversationType: convType ?? "personal" },
              ...(inboundActivityId && !msg.replyToId ? { replyToId: inboundActivityId } : {}),
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
          async updateActivity(
            activityUpdate: { id: string } & Record<string, unknown>,
          ): Promise<unknown> {
            const activityId = activityUpdate.id;
            if (!activityId || !serviceUrl) {
              return { id: "unknown" };
            }
            const convId = (activity?.conversation as Record<string, unknown>)?.id as
              | string
              | undefined;
            if (!convId) {
              return { id: "unknown" };
            }
            return await updateActivityViaRest({
              serviceUrl,
              conversationId: convId,
              activityId,
              activity: activityUpdate,
              token: await getToken(),
            });
          },
        };

        // For invoke activities, send HTTP 200 immediately before running
        // handler logic so slow operations (file uploads, reflections) don't
        // hit Teams invoke timeouts ("unable to reach app").
        if (isInvoke) {
          response.status(200).send();
        }

        await logic(context);

        if (!isInvoke) {
          response.status(200).send();
        }
      } catch (err) {
        if (!isInvoke) {
          response.status(500).send({ error: String(err) });
        }
      }
    },

    async updateActivity(_context, activity) {
      // No-op: updateActivity is handled via REST in streaming-message.ts
    },

    async deleteActivity(_context, _reference) {
      // No-op: deleteActivity not yet implemented for Teams SDK adapter
    },
  };
}

export async function loadMSTeamsSdkWithAuth(creds: MSTeamsCredentials) {
  const sdk = await loadMSTeamsSdk();
  const app = createMSTeamsApp(creds, sdk);
  return { sdk, app };
}

/**
 * Create a Bot Framework JWT validator using the Teams SDK's built-in
 * JwtValidator pre-configured for Bot Framework signing keys.
 *
 * Validates: signature (JWKS), audience (appId), issuer (api.botframework.com),
 * and expiration (5-minute clock tolerance).
 */
export async function createBotFrameworkJwtValidator(creds: MSTeamsCredentials): Promise<{
  validate: (authHeader: string, serviceUrl?: string) => Promise<boolean>;
}> {
  const { createServiceTokenValidator } =
    await import("@microsoft/teams.apps/dist/middleware/auth/jwt-validator.js");
  const validator = createServiceTokenValidator(creds.appId, creds.tenantId);

  return {
    async validate(authHeader: string, serviceUrl?: string): Promise<boolean> {
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
      if (!token) {
        return false;
      }
      try {
        const result = await validator.validateAccessToken(
          token,
          serviceUrl ? { validateServiceUrl: { expectedServiceUrl: serviceUrl } } : undefined,
        );
        return result != null;
      } catch {
        return false;
      }
    },
  };
}

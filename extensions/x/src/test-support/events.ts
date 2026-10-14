import { createXApiClient, type XApiClient, type XPost } from "../api.js";

export const post = (id: string): XPost => ({
  id,
  text: "@bot hello",
  author_id: "7",
  conversation_id: "1",
  entities: { mentions: [{ id: "9", username: "bot" }] },
});

export function budgetApi(
  spend: XApiClient["spend"],
  respond: (url: URL, init?: RequestInit) => Response | Promise<Response>,
) {
  return createXApiClient({
    spend,
    clientId: "client",
    clientSecret: "secret",
    refreshToken: "refresh",
    bearerToken: "bearer",
    saveRefreshToken: async () => {},
    fetch: async (input, init) => {
      const url = new URL(input);
      if (url.pathname.endsWith("/oauth2/token")) {
        return Response.json({ access_token: "access" });
      }
      if (url.pathname.endsWith("/subscriptions")) {
        return Response.json({
          data: [{ event_type: "post.mention.create", filter: { user_id: "9" } }],
        });
      }
      return respond(url, init);
    },
  });
}

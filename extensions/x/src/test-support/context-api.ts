import { createXTestApi as createXApiClient, type XFetch } from "./api-client.js";
import { createXTestSpend } from "./spend.js";

export function createContextApi(fetch: XFetch, dailyUsd?: number) {
  return createXApiClient({
    spend: createXTestSpend(dailyUsd === undefined ? {} : { dailyUsd }),
    clientId: "synthetic",
    clientSecret: "synthetic",
    refreshToken: "synthetic",
    saveRefreshToken: async () => {},
    fetch: (input, init) =>
      dailyUsd !== 0 && input.endsWith("/oauth2/token")
        ? Promise.resolve(Response.json({ access_token: "synthetic" }))
        : fetch(input, init),
  });
}

import { createXApiClient, type XFetch } from "../api.js";
import { createXTestSpend } from "./spend.js";

export function createXTestApi(
  options: Partial<Parameters<typeof createXApiClient>[0]> & { fetch: XFetch },
) {
  return createXApiClient({
    spend: createXTestSpend(),
    clientId: "client",
    clientSecret: "secret",
    refreshToken: "refresh",
    saveRefreshToken: async () => {},
    ...options,
  });
}

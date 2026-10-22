import { createXApiClient } from "../api.js";
import { createXGitHubReader } from "../github.js";
import { setXTestFetch, type XFetch } from "./fetch.js";
import { createXTestSpend } from "./spend.js";

export type { XFetch } from "./fetch.js";

export function createXTestApi(
  options: Partial<Parameters<typeof createXApiClient>[0]> & { fetch: XFetch },
) {
  const { fetch, ...apiOptions } = options;
  setXTestFetch("api.x.com", fetch);
  return createXApiClient({
    spend: createXTestSpend(),
    clientId: "client",
    clientSecret: "secret",
    refreshToken: "refresh",
    saveRefreshToken: async () => {},
    ...apiOptions,
  });
}

export function createXTestGitHubReader(
  options: Parameters<typeof createXGitHubReader>[0] & { fetch: XFetch },
) {
  const { fetch, ...readerOptions } = options;
  setXTestFetch("api.github.com", fetch);
  return createXGitHubReader(readerOptions);
}

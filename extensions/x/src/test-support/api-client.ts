import { createXApiClient } from "../api.js";
import { createXGitHubReader } from "../github.js";
import { setXTestFetch, type XFetch } from "./fetch.js";
import { createXTestSpend } from "./spend.js";

export type { XFetch } from "./fetch.js";

export function createXTestApi(
  options: Partial<Parameters<typeof createXApiClient>[0]> & {
    fetch: XFetch;
    loadRefreshToken?: () => Promise<string | undefined>;
    saveRefreshToken?: (token: string) => Promise<void>;
  },
) {
  const { fetch, loadRefreshToken, saveRefreshToken, ...apiOptions } = options;
  let refreshToken = apiOptions.refreshToken ?? "refresh";
  let loaded = false;
  setXTestFetch("api.x.com", fetch);
  return createXApiClient({
    spend: createXTestSpend(),
    clientId: "client",
    clientSecret: "secret",
    refreshToken: "refresh",
    claimRefreshToken: async () => {
      if (!loaded) {
        refreshToken = (await loadRefreshToken?.()) ?? refreshToken;
        loaded = true;
      }
      return {
        refreshToken,
        commit: async (next) => {
          await saveRefreshToken?.(next);
          refreshToken = next;
        },
        restore: async () => {},
      };
    },
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

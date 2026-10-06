import {
  callTwitchApi,
  HttpStatusCodeError,
  type TwitchApiCallFetchOptions,
} from "@twurple/api-call";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import type {
  ChannelResolveKind,
  ChannelResolveResult,
  ChannelLogSink,
  TwitchAccountConfig,
} from "./types.js";
import { normalizeToken } from "./utils/twitch.js";

const TWITCH_HELIX_USER_LOOKUP_TIMEOUT_MS = 10_000;

type TwitchTokenInfo = {
  user_id?: string;
};

type TwitchUser = {
  id: string;
  login: string;
  display_name: string;
};

type TwitchUsersResponse = {
  data: TwitchUser[];
};

function normalizeUsername(input: string): string {
  const trimmed = input.trim();
  if (trimmed.startsWith("@")) {
    return normalizeLowercaseStringOrEmpty(trimmed.slice(1));
  }
  return normalizeLowercaseStringOrEmpty(trimmed);
}

function createHelixUserResolver(clientId: string, accessToken: string) {
  let tokenValidated = false;

  return async (query: { id: string } | { login: string }): Promise<TwitchUser | null> => {
    const controller = new AbortController();
    // ApiClient retries AbortError past the deadline. This sequential startup
    // resolver uses Twurple's public one-shot call so cancellation stays bounded.
    const fetchOptions = { signal: controller.signal } as TwitchApiCallFetchOptions;
    const request = (async () => {
      if (!tokenValidated) {
        let tokenInfo: TwitchTokenInfo;
        try {
          tokenInfo = await callTwitchApi<TwitchTokenInfo>(
            { type: "auth", url: "validate" },
            clientId,
            accessToken,
            undefined,
            fetchOptions,
          );
        } catch (error) {
          if (error instanceof HttpStatusCodeError && error.statusCode === 401) {
            throw new Error("Invalid token supplied", { cause: error });
          }
          throw error;
        }
        if (!tokenInfo.user_id) {
          throw new Error("Trying to use an app access token as a user access token");
        }
        tokenValidated = true;
      }

      const response = await callTwitchApi<TwitchUsersResponse>(
        { type: "helix", url: "users", query },
        clientId,
        accessToken,
        undefined,
        fetchOptions,
      );
      return response.data[0] ?? null;
    })();

    try {
      return await withTimeout(
        request,
        TWITCH_HELIX_USER_LOOKUP_TIMEOUT_MS,
        "Twitch Helix user lookup",
      );
    } finally {
      controller.abort();
    }
  };
}

export async function resolveTwitchTargets(
  inputs: string[],
  account: TwitchAccountConfig,
  _kind: ChannelResolveKind,
  log?: ChannelLogSink,
): Promise<ChannelResolveResult[]> {
  if (!account.clientId || !account.accessToken) {
    log?.error("Missing Twitch client ID or accessToken");
    return inputs.map((input) => ({
      input,
      resolved: false,
      note: "missing Twitch credentials",
    }));
  }

  const normalizedToken = normalizeToken(account.accessToken);

  const resolveHelixUser = createHelixUserResolver(account.clientId, normalizedToken);

  const results: ChannelResolveResult[] = [];

  for (const input of inputs) {
    const normalized = normalizeUsername(input);

    if (!normalized) {
      results.push({
        input,
        resolved: false,
        note: "empty input",
      });
      continue;
    }

    const looksLikeUserId = /^\d+$/.test(normalized);

    try {
      const user = await resolveHelixUser(
        looksLikeUserId ? { id: normalized } : { login: normalized },
      );
      if (user) {
        results.push({
          input,
          resolved: true,
          id: user.id,
          name: user.login,
          ...(!looksLikeUserId
            ? {
                note:
                  user.display_name !== user.login ? `display: ${user.display_name}` : undefined,
              }
            : {}),
        });
        log?.debug?.(
          looksLikeUserId
            ? `Resolved user ID ${normalized} -> ${user.login}`
            : `Resolved username ${normalized} -> ${user.id} (${user.login})`,
        );
      } else {
        results.push({
          input,
          resolved: false,
          note: looksLikeUserId ? "user ID not found" : "username not found",
        });
        log?.warn(`${looksLikeUserId ? "User ID" : "Username"} ${normalized} not found`);
      }
    } catch (error) {
      const errorMessage = formatErrorMessage(error);
      results.push({
        input,
        resolved: false,
        note: `API error: ${errorMessage}`,
      });
      log?.error(`Failed to resolve ${input}: ${errorMessage}`);
    }
  }

  return results;
}

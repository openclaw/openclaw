import {
  createOAuthRefreshError,
  createOAuthRefreshResponseError,
  isRecoverableOAuthRefreshFailure,
  readOAuthRefreshErrorReason,
} from "openclaw/plugin-sdk/provider-oauth-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";
import { fetchXService } from "./fetch.js";

export type XTokenState = "idle" | "refreshing" | "ready" | "error";
export type XRefreshClaim = {
  refreshToken: string;
  commit: (refreshToken: string) => Promise<void>;
  restore: () => Promise<void>;
};
export type XOAuthOptions = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  claimRefreshToken: () => Promise<XRefreshClaim>;
  assertCurrent?: () => void;
  onTokenState?: (state: XTokenState) => void;
};

const failureMessage = "X token refresh failed; check the account credentials and token storage";
function unknownFailure() {
  return createOAuthRefreshError(failureMessage, {
    version: 1,
    phase: "after-token-response",
    outcome: "unknown",
  });
}

async function exchange(options: XOAuthOptions, refreshToken: string) {
  const signal = AbortSignal.timeout(30_000);
  let dispatched = false;
  let response: Response;
  try {
    response = await fetchXService(
      "api.x.com",
      "/2/oauth2/token",
      {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization:
            "Basic " +
            Buffer.from(
              encodeURIComponent(options.clientId) + ":" + encodeURIComponent(options.clientSecret),
            ).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }).toString(),
        signal,
      },
      () => options.assertCurrent,
      () => {
        dispatched = true;
      },
    );
  } catch {
    // Only the dispatch boundary proves nonattempt; a lost response can follow rotation.
    throw createOAuthRefreshError(
      failureMessage,
      dispatched
        ? { version: 1, phase: "token-response", outcome: "unknown" }
        : {
            version: 1,
            phase: "before-dispatch",
            outcome: "not-attempted",
            recovery: { kind: "later", evidence: "dispatch-not-started" },
          },
    );
  }
  let token: Record<string, unknown> | undefined;
  try {
    const bytes = await readResponseWithLimit(response, 262_144, { signal, timeoutMs: 30_000 });
    token = asOptionalRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  } catch {
    throw unknownFailure();
  }
  if (!response.ok || readOAuthRefreshErrorReason(token)) {
    throw createOAuthRefreshResponseError("X token refresh", response.status, token);
  }
  if (
    !token ||
    typeof token.access_token !== "string" ||
    !token.access_token.trim() ||
    (token.refresh_token !== undefined &&
      (typeof token.refresh_token !== "string" || !token.refresh_token.trim())) ||
    (token.token_type !== undefined &&
      (typeof token.token_type !== "string" || token.token_type.toLowerCase() !== "bearer")) ||
    (token.expires_in !== undefined &&
      (typeof token.expires_in !== "number" ||
        !Number.isFinite(token.expires_in) ||
        token.expires_in < 0))
  ) {
    throw unknownFailure();
  }
  const expiresAt =
    Date.now() +
    (typeof token.expires_in === "number" ? Math.max(0, token.expires_in - 30) : 7_170) * 1000;
  if (!Number.isSafeInteger(Math.ceil(expiresAt))) {
    throw unknownFailure();
  }
  return {
    accessToken: token.access_token,
    refreshToken: typeof token.refresh_token === "string" ? token.refresh_token : refreshToken,
    expiresAt,
  };
}

/** One in-flight owner; request cancellation detaches the caller, not this exchange. */
export function createXOAuthAccess(options: XOAuthOptions) {
  let accessToken: string | undefined;
  let expiresAt = 0;
  let refreshToken = options.refreshToken;
  let uncertain = false;
  let pending: { token: Awaited<ReturnType<typeof exchange>>; claim: XRefreshClaim } | undefined;
  let task: Promise<void> | undefined;
  async function refresh() {
    let providerFailure: unknown;
    options.onTokenState?.("refreshing");
    try {
      // Recover the completed exchange before admission of another rotating POST.
      let token: Awaited<ReturnType<typeof exchange>>;
      if (pending) {
        token = pending.token;
        await pending.claim.commit(token.refreshToken);
      } else {
        if (uncertain) {
          throw unknownFailure();
        }
        const owned = await options.claimRefreshToken();
        refreshToken = owned.refreshToken;
        uncertain = true;
        try {
          token = await exchange(options, refreshToken);
        } catch (error) {
          if (isRecoverableOAuthRefreshFailure(error)) {
            await owned.restore();
            uncertain = false;
          }
          providerFailure = error;
          throw error;
        }
        refreshToken = token.refreshToken;
        pending = { token, claim: owned };
        await owned.commit(refreshToken);
      }
      pending = undefined;
      uncertain = false;
      options.assertCurrent?.();
      accessToken = token.accessToken;
      expiresAt = token.expiresAt;
      options.onTokenState?.("ready");
    } catch (error) {
      accessToken = undefined;
      options.onTokenState?.("error");
      // Provider helpers contain no raw body/transport text. Storage/authority errors may.
      if (error === providerFailure) {
        throw error;
      }
      throw unknownFailure();
    }
  }
  return {
    async ensure(signal?: AbortSignal) {
      signal?.throwIfAborted();
      options.assertCurrent?.();
      if (!accessToken || Date.now() >= expiresAt) {
        task ??= refresh().finally(() => {
          task = undefined;
        });
        await racePromiseWithAbortSignal(task, signal);
      }
      options.assertCurrent?.();
      return accessToken;
    },
    invalidate(rejected: string) {
      if (accessToken === rejected) {
        accessToken = undefined;
      }
    },
    currentRefreshToken: () => refreshToken,
  };
}

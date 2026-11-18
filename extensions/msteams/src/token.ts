import { createHash } from "node:crypto";
import { isFutureDateTimestampMs } from "openclaw/plugin-sdk/number-runtime";
import {
  createOAuthRefreshError,
  isRecoverableOAuthRefreshFailure,
} from "openclaw/plugin-sdk/provider-oauth-runtime";
import {
  claimMSTeamsDelegatedTokenRefresh,
  loadMSTeamsDelegatedTokenState,
  normalizeMSTeamsDelegatedTokens,
} from "./delegated-state.js";
import { refreshMSTeamsDelegatedTokens } from "./oauth.token.js";
import { getMSTeamsRuntime } from "./runtime.js";
import { resolveMSTeamsAccountStateNamespace } from "./sqlite-state.js";

const refreshes = new WeakMap<object, Map<string, Promise<string | undefined>>>();

export async function resolveDelegatedAccessToken(params: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  accountId?: string | null;
}): Promise<string | undefined> {
  const runtime = getMSTeamsRuntime();
  const callerKey = createHash("sha256")
    .update(
      JSON.stringify([
        runtime.state.resolveStateDir(),
        resolveMSTeamsAccountStateNamespace("delegated-token", params.accountId),
        params.tenantId,
        params.clientId,
        params.clientSecret,
      ]),
    )
    .digest("hex");
  const state = await loadMSTeamsDelegatedTokenState(params.accountId);
  const tokens = normalizeMSTeamsDelegatedTokens(state);
  const active = refreshes.get(runtime) ?? new Map<string, Promise<string | undefined>>();
  refreshes.set(runtime, active);
  if (state && "refreshClaim" in state && state.callerKey === callerKey) {
    const pending = active.get(state.requestKey);
    if (pending) {
      return await pending;
    }
  }
  if (!tokens) {
    // A stranded claim stays fenced; only this caller's exact live owner can be joined.
    return state && "refreshClaim" in state && state.callerKey === callerKey
      ? await active.get(state.requestKey)
      : undefined;
  }
  if (isFutureDateTimestampMs(tokens.expiresAt)) {
    return tokens.accessToken;
  }
  const key = createHash("sha256")
    .update(JSON.stringify([callerKey, tokens]))
    .digest("hex");
  const pending = active.get(key);
  if (pending) {
    return await pending;
  }
  const task = (async () => {
    try {
      const claim = await claimMSTeamsDelegatedTokenRefresh(
        tokens,
        key,
        callerKey,
        params.accountId,
      );
      if (!claim) {
        return undefined;
      }
      let refreshed;
      try {
        if (getMSTeamsRuntime() !== runtime) {
          throw createOAuthRefreshError(
            "Microsoft Teams token owner changed before refresh dispatch",
            {
              version: 1,
              phase: "before-dispatch",
              outcome: "not-attempted",
              recovery: { kind: "later", evidence: "dispatch-not-started" },
            },
          );
        }
        refreshed = await refreshMSTeamsDelegatedTokens({
          ...params,
          refreshToken: tokens.refreshToken,
          scopes: tokens.scopes,
        });
      } catch (error) {
        if (isRecoverableOAuthRefreshFailure(error)) {
          await claim.settle(tokens);
        } else {
          await claim.reject();
        }
        return undefined;
      }
      // A failed publication returns no access; the retained Microsoft grant remains safely reusable.
      return (await claim.settle({ ...tokens, ...refreshed })) ? refreshed.accessToken : undefined;
    } catch {
      return undefined;
    }
  })();
  active.set(key, task);
  try {
    return await task;
  } finally {
    if (active.get(key) === task) {
      active.delete(key);
    }
  }
}

import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  accessTokenIsExpired,
  getTokenInfo,
  StaticAuthProvider,
  type AccessToken,
  type AuthProvider,
} from "@twurple/auth";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-resolution";
import { readProviderJsonObjectResponse } from "openclaw/plugin-sdk/provider-http";
import {
  createOAuthRefreshError,
  createOAuthRefreshResponseError,
  isRecoverableOAuthRefreshFailure,
  readOAuthRefreshErrorReason,
} from "openclaw/plugin-sdk/provider-oauth-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { getAccountConfig } from "./config.js";
import { getTwitchRuntime } from "./runtime.js";
import { resolveTwitchToken } from "./token.js";
import type { TwitchAccountConfig } from "./types.js";
import { normalizeToken } from "./utils/twitch.js";

type Grant = AccessToken & { userId?: string };
type Claim = { claim: string; completed?: AccessToken; expectedUserId?: string };
type State = { lineage: string } & ({ token: Grant } | Claim);
const tasks = new WeakMap<object, Map<string, Promise<Grant>>>();

function lineageOf(account: TwitchAccountConfig, token: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        account.username.toLowerCase(),
        account.clientId,
        account.clientSecret,
        token,
        account.refreshToken,
        account.expiresIn,
        account.obtainmentTimestamp,
      ]),
    )
    .digest("hex");
}

async function exchange(
  account: TwitchAccountConfig,
  refreshToken: string,
  assertCurrent: () => void,
): Promise<AccessToken> {
  let dispatched = false;
  const { response, release } = await fetchWithSsrFGuard({
    url: "https://id.twitch.tv/oauth2/token",
    policy: { allowedHostnames: ["id.twitch.tv"] },
    requireHttps: true,
    timeoutMs: 30_000,
    auditContext: "twitch.oauth.refresh",
    beforeRequest: () => {
      assertCurrent();
      dispatched = true;
    },
    init: {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: account.clientId!,
        client_secret: account.clientSecret!,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    },
  }).catch((cause: unknown) => {
    throw createOAuthRefreshError(
      "Twitch OAuth refresh transport failed",
      dispatched
        ? {
            version: 1,
            phase: "token-response",
            outcome: "unknown",
          }
        : {
            version: 1,
            phase: "before-dispatch",
            outcome: "not-attempted",
            recovery: { kind: "later", evidence: "dispatch-not-started" },
          },
      { cause },
    );
  });
  try {
    let payload: Record<string, unknown>;
    try {
      payload = await readProviderJsonObjectResponse(response, "Twitch OAuth refresh", {
        maxBytes: 256 * 1024,
      });
    } catch {
      throw createOAuthRefreshError("Twitch OAuth refresh returned an unreadable response", {
        version: 1,
        phase: "after-token-response",
        outcome: "unknown",
        status: response.status,
      });
    }
    if (!response.ok || readOAuthRefreshErrorReason(payload)) {
      throw createOAuthRefreshResponseError("Twitch OAuth refresh", response.status, payload);
    }
    if (
      typeof payload.access_token !== "string" ||
      !payload.access_token.trim() ||
      typeof payload.refresh_token !== "string" ||
      !payload.refresh_token.trim() ||
      typeof payload.expires_in !== "number" ||
      !Number.isFinite(payload.expires_in) ||
      payload.expires_in < 0 ||
      !Array.isArray(payload.scope) ||
      !payload.scope.every((scope): scope is string => typeof scope === "string") ||
      typeof payload.token_type !== "string" ||
      payload.token_type.toLowerCase() !== "bearer"
    ) {
      throw createOAuthRefreshError("Twitch OAuth refresh returned invalid tokens", {
        version: 1,
        phase: "after-token-response",
        outcome: "unknown",
        status: response.status,
      });
    }
    return {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token,
      expiresIn: payload.expires_in,
      scope: payload.scope,
      obtainmentTimestamp: Date.now(),
    };
  } finally {
    await release();
  }
}

/** One durable channel-account owner, including the initial and IRC-requested refresh. */
export async function createManagedTwitchAuthProvider(
  account: TwitchAccountConfig,
  token: string,
  accountId?: string,
): Promise<AuthProvider> {
  const clientId = account.clientId;
  if (!clientId) {
    throw new Error("Twitch OAuth requires a client ID");
  }
  const runtime = getTwitchRuntime();
  const id = normalizeAccountId(accountId);
  const lineage = lineageOf(account, token);
  const assertCurrent = () => {
    if (getTwitchRuntime() !== runtime) {
      throw new Error("Twitch OAuth runtime changed");
    }
    const cfg = runtime.config.current({ clone: true });
    const current = getAccountConfig(cfg, id);
    if (cfg.channels?.twitch?.enabled === false || current?.enabled === false) {
      throw new Error("Twitch account is disabled; enable it before using its OAuth grant");
    }
    const currentToken = normalizeToken(resolveTwitchToken(cfg, id).token);
    if (!current || lineageOf(current, currentToken) !== lineage) {
      throw new Error("Twitch OAuth account changed; retry with its current configuration");
    }
  };
  assertCurrent();
  const namespace = "oauth-" + id;
  const key = runtime.state.resolveStateDir() + ":" + id + ":" + lineage;
  const resolve = async (force = false): Promise<Grant> => {
    assertCurrent();
    let active = tasks.get(runtime);
    if (!active) {
      active = new Map();
      tasks.set(runtime, active);
    }
    const pending = active.get(key);
    if (pending) {
      return await pending;
    }
    const task = (async () => {
      const store = runtime.state.openKeyedStoreV2<State>(
        { namespace, maxEntries: 1, overflowPolicy: "reject-new" },
        { assertCurrent },
      );
      let observed = await store.observe("current");
      if (observed.value?.lineage !== lineage) {
        const initialized = await store.compareAndApply("current", observed.comparison, {
          operation: "update",
          action: "set",
          value: {
            lineage,
            token: {
              accessToken: token,
              refreshToken: account.refreshToken ?? null,
              expiresIn: account.expiresIn ?? null,
              obtainmentTimestamp: account.obtainmentTimestamp ?? Date.now(),
              scope: [],
            },
          },
        });
        observed =
          initialized.status === "conflict" ? initialized.current : await store.observe("current");
      }
      const validateCompleted = async (
        claim: { lineage: string } & Claim & { completed: AccessToken },
      ) => {
        // A validation outage retries only this GET, never the already-completed token POST.
        assertCurrent();
        const info = await getTokenInfo(claim.completed.accessToken, clientId);
        assertCurrent();
        const current = await store.observe("current");
        if (!isDeepStrictEqual(current.value, claim)) {
          throw new Error("Twitch OAuth refresh owner changed before validation");
        }
        if (
          !info.userId ||
          info.userName?.toLowerCase() !== account.username.toLowerCase() ||
          (claim.expectedUserId && info.userId !== claim.expectedUserId)
        ) {
          await store.compareAndApply("current", current.comparison, {
            operation: "update",
            action: "set",
            value: { lineage, claim: claim.claim },
          });
          throw new Error(
            "Twitch OAuth refresh returned a different account; reauthorize the configured grant",
          );
        }
        const replacement = { ...claim.completed, userId: info.userId };
        const result = await store.compareAndApply("current", current.comparison, {
          operation: "update",
          action: "set",
          value: { lineage, token: replacement },
        });
        if (result.status !== "applied") {
          throw new Error("Twitch OAuth refresh owner changed before settlement");
        }
        assertCurrent();
        return replacement;
      };
      if (
        observed.value?.lineage === lineage &&
        "claim" in observed.value &&
        observed.value.completed
      ) {
        return await validateCompleted({ ...observed.value, completed: observed.value.completed });
      }
      assertCurrent();
      if (!observed.value || observed.value.lineage !== lineage || !("token" in observed.value)) {
        throw new Error(
          "Twitch OAuth refresh is pending or its outcome is uncertain; reauthorize the configured grant",
        );
      }
      const original = observed.value.token;
      if (!force && !accessTokenIsExpired(original)) {
        return original;
      }
      if (!original.refreshToken) {
        throw new Error("Twitch OAuth refresh requires a refresh token");
      }
      const claim: State = { lineage, claim: randomUUID() };
      const claimed = await store.compareAndApply("current", observed.comparison, {
        operation: "update",
        action: "set",
        value: claim,
      });
      if (claimed.status !== "applied") {
        throw new Error("Twitch OAuth grant changed before refresh; retry with its current owner");
      }
      const settle = async (replacement: Grant) => {
        const current = await store.observe("current");
        if (!isDeepStrictEqual(current.value, claim)) {
          throw new Error("Twitch OAuth refresh owner changed before settlement");
        }
        const result = await store.compareAndApply("current", current.comparison, {
          operation: "update",
          action: "set",
          value: { lineage, token: replacement },
        });
        if (result.status !== "applied") {
          throw new Error("Twitch OAuth refresh owner changed before settlement");
        }
        assertCurrent();
      };
      assertCurrent();
      let refreshed: AccessToken;
      try {
        refreshed = await exchange(account, original.refreshToken, assertCurrent);
      } catch (error) {
        if (isRecoverableOAuthRefreshFailure(error)) {
          await settle(original);
        }
        throw error;
      }
      // Preserve the completed exchange before any fallible identity lookup. A crash or
      // lost write reply can resume validation with the rotated grant, without replay.
      const completed = {
        ...claim,
        completed: refreshed,
        ...(original.userId ? { expectedUserId: original.userId } : {}),
      };
      const current = await store.observe("current");
      if (!isDeepStrictEqual(current.value, claim)) {
        throw new Error("Twitch OAuth refresh owner changed before completion");
      }
      const saved = await store.compareAndApply("current", current.comparison, {
        operation: "update",
        action: "set",
        value: completed,
      });
      if (saved.status !== "applied") {
        throw new Error("Twitch OAuth refresh owner changed before completion");
      }
      return await validateCompleted(completed);
    })();
    active.set(key, task);
    try {
      return await task;
    } finally {
      if (active.get(key) === task) {
        active.delete(key);
      }
    }
  };
  let grant = await resolve();
  let staticProvider = new StaticAuthProvider(clientId, grant);
  const prepare = async (force = false) => {
    const current = await resolve(force);
    if (current.accessToken !== grant.accessToken) {
      staticProvider = new StaticAuthProvider(clientId, current);
    }
    grant = current;
    assertCurrent();
    return staticProvider;
  };
  return {
    clientId,
    hasClientSecret: true,
    getCurrentScopesForUser: () => staticProvider.getCurrentScopesForUser(),
    async getAccessTokenForUser(user, ...scopeSets) {
      const auth = await prepare();
      const result = await auth.getAccessTokenForUser(user, ...scopeSets);
      assertCurrent();
      return result;
    },
    async getAccessTokenForIntent(intent, ...scopeSets) {
      if (intent !== "chat") {
        return null;
      }
      const auth = await prepare();
      const result = await auth.getAccessTokenForIntent(intent, ...scopeSets);
      assertCurrent();
      return result;
    },
    async getAnyAccessToken() {
      const result = await (await prepare()).getAnyAccessToken();
      assertCurrent();
      return result;
    },
    async refreshAccessTokenForIntent(intent) {
      if (intent !== "chat") {
        throw new Error("Unknown Twitch OAuth intent");
      }
      const result = await (await prepare(true)).getAccessTokenForIntent(intent);
      assertCurrent();
      return result;
    },
    async refreshAccessTokenForUser(user) {
      const result = await (await prepare(true)).getAccessTokenForUser(user);
      assertCurrent();
      return result;
    },
  };
}

import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { isRecoverableOAuthRefreshFailure } from "openclaw/plugin-sdk/provider-oauth-runtime";
import { resolveGoogleMeetConfig, type GoogleMeetConfig } from "./config.js";
import { refreshGoogleMeetAccessToken, shouldUseCachedGoogleMeetAccessToken } from "./oauth.js";

export type GoogleMeetOAuthRuntime = {
  state: Pick<OpenClawPluginApi["runtime"]["state"], "openKeyedStoreV2">;
  config: Pick<OpenClawPluginApi["runtime"]["config"], "current">;
};
type OAuthConfig = GoogleMeetConfig["oauth"];
type Credential = { accessToken?: string; refreshToken: string; expiresAt?: number };
// Google documents refresh grants as reusable while valid; retain one across a crashed claim.
type State = { lineage: string } & ({ credential: Credential; claim?: string } | { claim: string });
const tasks = new WeakMap<
  GoogleMeetOAuthRuntime,
  Map<string, Promise<{ accessToken: string; expiresAt?: number; refreshed: boolean }>>
>();

function lineageOf(oauth: OAuthConfig): string {
  const grant = JSON.stringify([
    oauth.clientId,
    oauth.clientSecret,
    oauth.refreshToken,
    oauth.accessToken,
    oauth.expiresAt,
  ]);
  // The lineage detects a changed configured grant; it is not password storage
  // or credential verification. It is persisted with the owned credential, so it
  // must stay stable across restarts.
  return createHash("sha256").update(grant).digest("hex");
}

/** Config identifies the grant; this plugin-owned row owns all later rotations. */
export async function resolveManagedGoogleMeetAccessToken(
  oauth: OAuthConfig,
  runtime: GoogleMeetOAuthRuntime,
) {
  const lineage = lineageOf(oauth);
  const assertCurrent = () => {
    const entry = runtime.config.current().plugins?.entries?.["google-meet"];
    const current = resolveGoogleMeetConfig(entry?.config);
    if (entry?.enabled === false || !current.enabled) {
      throw new Error("Google Meet is disabled; enable it before using its OAuth grant");
    }
    if (lineageOf(current.oauth) !== lineage) {
      throw new Error("Google Meet OAuth account changed; retry with its current configuration");
    }
  };
  assertCurrent();
  const pending = tasks.get(runtime)?.get(lineage);
  if (pending) {
    return await pending;
  }
  const task = (async () => {
    if (!oauth.clientId || !oauth.refreshToken) {
      const { resolveGoogleMeetAccessToken } = await import("./oauth.js");
      return await resolveGoogleMeetAccessToken(oauth);
    }
    const store = runtime.state.openKeyedStoreV2<State>(
      { namespace: "oauth-credential", maxEntries: 1, overflowPolicy: "reject-new" },
      { assertCurrent },
    );
    let observed = await store.observe("current");
    if (observed.value?.lineage !== lineage) {
      const initialized = await store.compareAndApply("current", observed.comparison, {
        operation: "update",
        action: "set",
        value: {
          lineage,
          credential: {
            accessToken: oauth.accessToken,
            refreshToken: oauth.refreshToken,
            expiresAt: oauth.expiresAt,
          },
        },
      });
      observed =
        initialized.status === "conflict" ? initialized.current : await store.observe("current");
    }
    assertCurrent();
    if (
      !observed.value ||
      observed.value.lineage !== lineage ||
      !("credential" in observed.value)
    ) {
      throw new Error(
        "Google Meet OAuth refresh is pending or its outcome is uncertain; reauthorize the configured grant",
      );
    }
    const credential = observed.value.credential;
    if (credential.accessToken && shouldUseCachedGoogleMeetAccessToken(credential)) {
      return {
        accessToken: credential.accessToken,
        expiresAt: credential.expiresAt,
        refreshed: false,
      };
    }
    const claimId = randomUUID();
    const claim: State = { lineage, credential, claim: claimId };
    const claimed = await store.compareAndApply("current", observed.comparison, {
      operation: "update",
      action: "set",
      value: claim,
    });
    if (claimed.status !== "applied") {
      throw new Error(
        "Google Meet OAuth grant changed before refresh; retry with the current owner",
      );
    }
    const settle = async (replacement: Credential) => {
      const current = await store.observe("current");
      if (!isDeepStrictEqual(current.value, claim)) {
        throw new Error("Google Meet OAuth refresh owner changed before settlement");
      }
      const result = await store.compareAndApply("current", current.comparison, {
        operation: "update",
        action: "set",
        value: { lineage, credential: replacement },
      });
      if (result.status !== "applied") {
        throw new Error("Google Meet OAuth refresh owner changed before settlement");
      }
      assertCurrent();
    };
    assertCurrent();
    let refreshed: Awaited<ReturnType<typeof refreshGoogleMeetAccessToken>>;
    try {
      refreshed = await refreshGoogleMeetAccessToken({
        clientId: oauth.clientId,
        clientSecret: oauth.clientSecret,
        refreshToken: credential.refreshToken,
      });
    } catch (error) {
      // Terminal rejection fences the grant; interrupted reusable exchanges retain a recovery path.
      if (isRecoverableOAuthRefreshFailure(error)) {
        await settle(credential);
      } else {
        const current = await store.observe("current");
        if (isDeepStrictEqual(current.value, claim)) {
          await store.compareAndApply("current", current.comparison, {
            operation: "update",
            action: "set",
            value: { lineage, claim: claimId },
          });
        }
      }
      throw error;
    }
    await settle({
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? credential.refreshToken,
      expiresAt: refreshed.expiresAt,
    });
    return { accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt, refreshed: true };
  })();
  let owned = tasks.get(runtime);
  if (!owned) {
    owned = new Map();
    tasks.set(runtime, owned);
  }
  owned.set(lineage, task);
  try {
    return await task;
  } finally {
    if (owned.get(lineage) === task) {
      owned.delete(lineage);
    }
  }
}

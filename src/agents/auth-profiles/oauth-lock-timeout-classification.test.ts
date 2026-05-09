import { describe, expect, it } from "vitest";
import {
  OPENCLAW_STATE_LOCK_TIMEOUT_ERROR_CODE,
  OpenClawStateLockTimeoutError,
} from "../../state/openclaw-state-lock.js";
import {
  buildRefreshContentionError,
  isGlobalRefreshLockTimeoutError,
} from "./oauth-refresh-lock-errors.js";
import { OAUTH_REFRESH_LOCK_SCOPE, resolveOAuthRefreshLockKey } from "./paths.js";

describe("OAuth refresh lock timeout classification", () => {
  it("matches only the global refresh lock key", () => {
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const refreshLockKey = resolveOAuthRefreshLockKey(provider, profileId);

    expect(
      isGlobalRefreshLockTimeoutError(
        new OpenClawStateLockTimeoutError(OAUTH_REFRESH_LOCK_SCOPE, refreshLockKey),
        OAUTH_REFRESH_LOCK_SCOPE,
        refreshLockKey,
      ),
    ).toBe(true);
    expect(
      isGlobalRefreshLockTimeoutError(
        new OpenClawStateLockTimeoutError("other.scope", refreshLockKey),
        OAUTH_REFRESH_LOCK_SCOPE,
        refreshLockKey,
      ),
    ).toBe(false);
  });

  it("builds refresh_contention errors that preserve the SQLite lock cause", () => {
    const profileId = "openai-codex:default";
    const provider = "openai-codex";
    const cause = new OpenClawStateLockTimeoutError(
      OAUTH_REFRESH_LOCK_SCOPE,
      resolveOAuthRefreshLockKey(provider, profileId),
    );

    const error = buildRefreshContentionError({ provider, profileId, cause });

    expect(error.code).toBe("refresh_contention");
    expect(error.cause).toBe(cause);
    expect(cause.code).toBe(OPENCLAW_STATE_LOCK_TIMEOUT_ERROR_CODE);
    expect(cause.scope).toBe(OAUTH_REFRESH_LOCK_SCOPE);
    expect(error.message).toContain("another process is already refreshing");
    expect(error.message).toContain("Please wait for the in-flight refresh to finish and retry.");
  });
});

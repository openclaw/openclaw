import { afterEach, describe, expect, it, vi } from "vitest";
import { markAuthProfileGood } from "./profiles.js";
import type { AuthProfileStore } from "./types.js";
import { markAuthProfileFailure, markAuthProfileUsed } from "./usage.js";

// Regression: #62099. On Windows, concurrent config hot-reload can leave
// auth-profiles.json with a ReadOnly attribute, and saveAuthProfileStore
// throws EPERM. The mark* functions run as post-completion bookkeeping
// (after the LLM request has already returned), so the throw used to
// cascade into the request flow and make the gateway unresponsive. They
// must now swallow persistence failures instead.

vi.mock("./store.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./store.js")>();
  const buildEperm = (): Error => {
    const err = new Error(
      "EPERM: operation not permitted, copyfile auth-profiles.json.tmp -> auth-profiles.json",
    );
    (err as NodeJS.ErrnoException).code = "EPERM";
    return err;
  };
  return {
    ...original,
    // Mirror the observed Windows hot-reload race: both the lock-guarded
    // update path and the direct save path hit the read-only file.
    updateAuthProfileStoreWithLock: vi.fn().mockRejectedValue(buildEperm()),
    saveAuthProfileStore: vi.fn(() => {
      throw buildEperm();
    }),
  };
});

function makeStore(): AuthProfileStore {
  return {
    version: 1,
    profiles: {
      "anthropic:default": {
        type: "api_key",
        provider: "anthropic",
        key: "sk-test",
      },
      "openai:default": {
        type: "api_key",
        provider: "openai",
        key: "sk-test-2",
      },
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("auth-profile bookkeeping persists best-effort on EPERM", () => {
  it("markAuthProfileGood does not throw when the store cannot be persisted", async () => {
    const store = makeStore();
    await expect(
      markAuthProfileGood({
        store,
        provider: "anthropic",
        profileId: "anthropic:default",
      }),
    ).resolves.toBeUndefined();
  });

  it("markAuthProfileUsed does not throw when the store cannot be persisted", async () => {
    const store = makeStore();
    await expect(
      markAuthProfileUsed({
        store,
        profileId: "anthropic:default",
      }),
    ).resolves.toBeUndefined();
  });

  it("markAuthProfileFailure does not throw when the store cannot be persisted", async () => {
    const store = makeStore();
    await expect(
      markAuthProfileFailure({
        store,
        profileId: "anthropic:default",
        reason: "rate_limit",
      }),
    ).resolves.toBeUndefined();
  });
});

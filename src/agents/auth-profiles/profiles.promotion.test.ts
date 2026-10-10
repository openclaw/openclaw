import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { AUTH_STORE_VERSION } from "./constants.js";
import { createApiKeyCredential } from "./credential-fixtures.test-support.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import { withAuthProfileTestState } from "./profile-mutations.test-support.js";
import { promoteAuthProfileInOrder } from "./profiles.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./runtime-snapshots.js";
import * as authStoreRuntime from "./store-runtime.js";
import { saveAuthProfileStore } from "./store-runtime.js";

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeAuthProfileStoreSnapshots();
});

it("preserves profile order when requester authority ends after update preparation", async () => {
  await withAuthProfileTestState("openclaw-auth-order-revoked-", async ({ agentDir }) => {
    fs.mkdirSync(agentDir, { recursive: true });
    saveAuthProfileStore(
      {
        version: AUTH_STORE_VERSION,
        profiles: {
          "openai:old": createApiKeyCredential("openai", "synthetic-old"),
          "openai:new": createApiKeyCredential("openai", "synthetic-new"),
        },
        order: { openai: ["openai:old"] },
      },
      agentDir,
    );
    let current = true;
    const update = authStoreRuntime.updateAuthProfileStoreWithLock;
    vi.spyOn(authStoreRuntime, "updateAuthProfileStoreWithLock").mockImplementation((params) =>
      update({
        ...params,
        updater: (...args) => {
          const changed = params.updater(...args);
          current = false;
          return changed;
        },
      }),
    );
    await expect(
      promoteAuthProfileInOrder({
        agentDir,
        provider: "openai",
        profileId: "openai:new",
        createIfMissing: true,
        assertCurrent: () => {
          if (!current) throw new Error("Login requester revoked");
        },
      }),
    ).rejects.toThrow("Login requester revoked");
    expect(loadPersistedAuthProfileStore(agentDir)?.order).toEqual({ openai: ["openai:old"] });
  });
});

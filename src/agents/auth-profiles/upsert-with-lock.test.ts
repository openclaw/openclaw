import { afterEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  updateAuthProfileStoreWithLock: vi.fn(),
}));

vi.mock("./credential-normalize.js", () => ({
  normalizeAuthProfileCredential: (credential: unknown) => credential,
}));
vi.mock("./store-runtime.js", () => ({
  updateAuthProfileStoreWithLock: hoisted.updateAuthProfileStoreWithLock,
}));

import * as persisted from "./persisted.js";
import { upsertAuthProfileWithLockOrThrow } from "./upsert-with-lock.js";

afterEach(() => vi.restoreAllMocks());

describe("upsertAuthProfileWithLockOrThrow", () => {
  it("fails with the canonical retry guidance when the locked update fails", async () => {
    hoisted.updateAuthProfileStoreWithLock.mockResolvedValue(null);
    vi.spyOn(persisted, "loadPersistedAuthProfileStore").mockImplementation(() => {
      throw new Error("Static tokens must reach the write owner without a preparatory read");
    });

    await expect(
      upsertAuthProfileWithLockOrThrow({
        profileId: "test:default",
        credential: { type: "token", provider: "test", token: "secret" },
      }),
    ).rejects.toThrow(
      "Failed to update auth profile store; the auth store lock may be busy. Wait a moment and retry.",
    );
  });
});

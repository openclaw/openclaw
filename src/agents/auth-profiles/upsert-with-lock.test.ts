import { describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  updateAuthProfileStoreWithLock: vi.fn(),
}));

vi.mock("./credential-normalize.js", () => ({
  normalizeAuthProfileCredential: (credential: unknown) => credential,
}));
vi.mock("./store-runtime.js", () => ({
  updateAuthProfileStoreWithLock: hoisted.updateAuthProfileStoreWithLock,
}));

import { upsertAuthProfileWithLockOrThrow } from "./upsert-with-lock.js";

describe("upsertAuthProfileWithLockOrThrow", () => {
  it("fails with the canonical retry guidance when the locked update fails", async () => {
    hoisted.updateAuthProfileStoreWithLock.mockResolvedValue(null);

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

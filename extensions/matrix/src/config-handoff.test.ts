import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "./types.js";

const mocks = vi.hoisted(() => ({
  runtime: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(async () => {}),
  replaceConfigFile: vi.fn(async () => {}),
  setDisplayName: vi.fn(async () => {}),
  setAvatarUrl: vi.fn(async () => {}),
}));

vi.mock("./runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime.js")>()),
  getMatrixRuntime: mocks.runtime,
}));
vi.mock("./matrix/client.js", async () => ({
  resolveMatrixAuthContext: (await import("./matrix/client/config.js")).resolveMatrixAuthContext,
  acquireSharedMatrixClient: mocks.acquire,
}));

import {
  handleVerificationBootstrap,
  handleVerificationStatus,
  handleVerifyRecoveryKey,
} from "./plugin-entry.runtime.js";
import { applyMatrixProfileUpdate } from "./profile-update.js";

const cfg: CoreConfig = {
  channels: { matrix: { accounts: { ops: { homeserver: "https://matrix.example.org" } } } },
};

describe("Matrix command config handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runtime.mockReturnValue({
      config: { current: () => cfg, replaceConfigFile: mocks.replaceConfigFile },
    });
    mocks.acquire.mockResolvedValue({
      client: {
        prepareForOneOff: async () => {},
        getUserId: async () => "@bot:example.org",
        getUserProfile: async () => ({ displayname: "Old Bot" }),
        setDisplayName: mocks.setDisplayName,
        setAvatarUrl: mocks.setAvatarUrl,
        verifyWithRecoveryKey: async () => ({ success: true }),
        bootstrapOwnDeviceVerification: async () => ({ success: true }),
        getOwnDeviceVerificationStatus: async () => ({ serverDeviceKnown: false }),
      },
      start: async () => {},
      release: mocks.release,
    });
  });

  it.each([false, true])("updates the profile with explicit config=%s", async (explicit) => {
    const supplied: CoreConfig = {
      channels: { matrix: { accounts: { ops: { homeserver: "https://tool.example.org" } } } },
    };
    const result = await applyMatrixProfileUpdate({
      account: "ops",
      displayName: "Ops Bot",
      avatarUrl: "mxc://example.org/avatar",
      ...(explicit ? { cfg: supplied } : {}),
    });

    expect(result.profile).toMatchObject({ displayNameUpdated: true, avatarUpdated: true });
    expect(mocks.setDisplayName).toHaveBeenCalledWith("Ops Bot");
    expect(mocks.setAvatarUrl).toHaveBeenCalledWith("mxc://example.org/avatar");
    expect(mocks.acquire).toHaveBeenCalledWith(
      expect.objectContaining({ cfg: explicit ? supplied : cfg }),
    );
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        nextConfig: expect.objectContaining({
          channels: {
            matrix: {
              enabled: true,
              accounts: {
                ops: {
                  homeserver: "https://matrix.example.org",
                  enabled: true,
                  name: "Ops Bot",
                  avatarUrl: "mxc://example.org/avatar",
                },
              },
            },
          },
        }),
      }),
    );
    expect(mocks.release).toHaveBeenCalledWith({ mode: "persist" });
  });

  it.each([
    ["recovery key", handleVerifyRecoveryKey, { key: "synthetic-recovery-key" }, { success: true }],
    ["bootstrap", handleVerificationBootstrap, {}, { success: true }],
    ["status", handleVerificationStatus, {}, { serverDeviceKnown: false, pendingVerifications: 0 }],
  ] as const)(
    "runs %s verification with Gateway config",
    async (_label, handle, params, result) => {
      const respond = vi.fn();
      await handle({
        params: { accountId: "ops", ...params },
        respond,
        context: { getRuntimeConfig: () => cfg },
      });

      expect(respond).toHaveBeenCalledWith(true, result);
      expect(mocks.acquire).toHaveBeenCalledWith(
        expect.objectContaining({ cfg, accountId: "ops" }),
      );
      expect(mocks.release).toHaveBeenCalledTimes(1);
    },
  );
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreConfig } from "./types.js";

const mocks = vi.hoisted(() => ({
  runtime: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(async () => {}),
  replaceConfigFile: vi.fn(async () => {}),
  setDisplayName: vi.fn(async () => {}),
  setAvatarUrl: vi.fn(async () => {}),
  bootstrap: vi.fn(async () => ({ success: true })),
  recoveryKey: vi.fn(async () => ({ encodedPrivateKey: "synthetic-stored-key" })),
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

const account = { homeserver: "https://matrix.example.org" };
function config(ops = account): CoreConfig {
  return { channels: { matrix: { accounts: { ops } } } };
}
const cfg = config();
const context = { getRuntimeConfig: () => cfg };

async function invoke(
  handle: typeof handleVerificationBootstrap,
  params: Parameters<typeof handleVerificationBootstrap>[0]["params"],
) {
  const respond = vi.fn();
  await handle({ params, respond, context });
  return respond;
}

describe("Matrix command config handoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.bootstrap.mockResolvedValue({ success: true });
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
        bootstrapOwnDeviceVerification: mocks.bootstrap,
        crypto: { listVerifications: async () => [], getRecoveryKey: mocks.recoveryKey },
        getOwnDeviceVerificationStatus: async () => ({ serverDeviceKnown: false }),
      },
      start: async () => {},
      release: mocks.release,
    });
  });

  it.each([false, true])("updates the profile with explicit config=%s", async (explicit) => {
    const supplied = config({ homeserver: "https://tool.example.org" });
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
    const ops = {
      ...account,
      enabled: true,
      name: "Ops Bot",
      avatarUrl: "mxc://example.org/avatar",
    };
    const nextConfig = { channels: { matrix: { enabled: true, accounts: { ops } } } };
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({
        nextConfig: expect.objectContaining(nextConfig),
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
      for (const routed of [false, true]) {
        const response = await invoke(handle, {
          accountId: "ops",
          ...params,
          ...(routed ? { expectedOwnerId: "owner-fixture" } : {}),
        });
        expect(response).toHaveBeenCalledWith(true, routed ? { result, accountId: "ops" } : result);
      }
      expect(mocks.acquire).toHaveBeenCalledWith(
        expect.objectContaining({ cfg, accountId: "ops" }),
      );
      expect(mocks.release).toHaveBeenCalledTimes(2);
    },
  );

  it("preserves structured verification failure for CLI rendering and legacy RPCs", async () => {
    mocks.bootstrap.mockResolvedValue({ success: false });
    for (const routed of [false, true]) {
      const response = await invoke(
        handleVerificationBootstrap,
        routed ? { expectedOwnerId: "owner-fixture" } : {},
      );
      expect(response).toHaveBeenCalledWith(
        routed,
        routed ? { result: { success: false }, accountId: "ops" } : { success: false },
      );
    }
  });

  it.each([false, true])(
    "includes the stored recovery key only when explicitly requested (%s)",
    async (includeRecoveryKey) => {
      const response = await invoke(handleVerificationStatus, {
        expectedOwnerId: "owner-fixture",
        includeRecoveryKey,
        allowDegradedLocalState: true,
      });
      expect(response).toHaveBeenCalledWith(true, {
        accountId: "ops",
        result: {
          serverDeviceKnown: false,
          pendingVerifications: 0,
          ...(includeRecoveryKey ? { recoveryKey: "synthetic-stored-key" } : {}),
        },
      });
      expect(mocks.recoveryKey).toHaveBeenCalledTimes(includeRecoveryKey ? 1 : 0);
      expect(mocks.release).toHaveBeenCalledWith({ mode: "persist" });
    },
  );
});

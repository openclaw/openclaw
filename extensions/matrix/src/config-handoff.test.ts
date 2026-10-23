import { beforeEach, expect, it, vi } from "vitest";
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
const status = { serverDeviceKnown: false, pendingVerifications: 0 };

async function expectReply(
  handle: typeof handleVerificationBootstrap,
  params: Parameters<typeof handleVerificationBootstrap>[0]["params"],
  result: unknown,
  routed = false,
  success = true,
) {
  const respond = vi.fn();
  await handle({
    params: { ...params, ...(routed ? { expectedOwnerId: "owner-fixture" } : {}) },
    respond,
    context,
  });
  expect(respond).toHaveBeenCalledWith(
    routed || success,
    routed ? { result, accountId: "ops" } : result,
  );
}

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
  const ops = { ...account, enabled: true, name: "Ops Bot", avatarUrl: "mxc://example.org/avatar" };
  const nextConfig = { channels: { matrix: { enabled: true, accounts: { ops } } } };
  expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
    expect.objectContaining({ nextConfig: expect.objectContaining(nextConfig) }),
  );
  expect(mocks.release).toHaveBeenCalledWith({ mode: "persist" });
});

it.each([
  ["recovery key", handleVerifyRecoveryKey, { key: "synthetic-recovery-key" }, { success: true }],
  ["bootstrap", handleVerificationBootstrap, {}, { success: true }],
  ["bootstrap failure", handleVerificationBootstrap, {}, { success: false }],
  ["status", handleVerificationStatus, {}, status],
] as const)("runs %s verification with Gateway config", async (_label, handle, params, result) => {
  const success = !("success" in result) || result.success;
  mocks.bootstrap.mockResolvedValue({ success });
  const request = success ? { accountId: "ops", ...params } : params;
  for (const routed of [false, true]) {
    await expectReply(handle, request, result, routed, success);
  }
  expect(mocks.acquire).toHaveBeenCalledWith(
    expect.objectContaining({ cfg, accountId: success ? "ops" : undefined }),
  );
  expect(mocks.release).toHaveBeenCalledTimes(2);
});

it.each([false, true])(
  "includes recovery key only if requested (%s)",
  async (includeRecoveryKey) => {
    await expectReply(
      handleVerificationStatus,
      { includeRecoveryKey, allowDegradedLocalState: true },
      { ...status, ...(includeRecoveryKey ? { recoveryKey: "synthetic-stored-key" } : {}) },
      true,
    );
    expect(mocks.recoveryKey).toHaveBeenCalledTimes(includeRecoveryKey ? 1 : 0);
    expect(mocks.release).toHaveBeenCalledWith({ mode: "persist" });
  },
);

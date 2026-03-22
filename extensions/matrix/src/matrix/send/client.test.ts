import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockMatrixClient,
  matrixClientResolverMocks,
  primeMatrixClientResolverMocks,
} from "../client-resolver.test-helpers.js";

const {
  getMatrixRuntimeMock,
  getActiveMatrixClientMock,
  acquireSharedMatrixClientMock,
  releaseSharedClientInstanceMock,
  isBunRuntimeMock,
  resolveMatrixAuthContextMock,
} = matrixClientResolverMocks;

vi.mock("../active-client.js", () => ({
  getActiveMatrixClient: (...args: unknown[]) => getActiveMatrixClientMock(...args),
}));

vi.mock("../client.js", () => ({
  acquireSharedMatrixClient: (...args: unknown[]) => acquireSharedMatrixClientMock(...args),
  isBunRuntime: () => isBunRuntimeMock(),
  resolveMatrixAuthContext: resolveMatrixAuthContextMock,
}));

vi.mock("../client/shared.js", () => ({
  releaseSharedClientInstance: (...args: unknown[]) => releaseSharedClientInstanceMock(...args),
}));

vi.mock("../../runtime.js", () => ({
  getMatrixRuntime: () => getMatrixRuntimeMock(),
}));

const { withResolvedMatrixClient } = await import("./client.js");

describe("withResolvedMatrixClient", () => {
  beforeEach(() => {
    primeMatrixClientResolverMocks({
      resolved: {},
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("stops one-off shared clients when no active monitor client is registered", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", "18799");

    const result = await withResolvedMatrixClient({ accountId: "default" }, async () => "ok");

    expect(getActiveMatrixClientMock).toHaveBeenCalledWith("default");
    expect(acquireSharedMatrixClientMock).toHaveBeenCalledTimes(1);
    expect(acquireSharedMatrixClientMock).toHaveBeenCalledWith({
      cfg: {},
      timeoutMs: undefined,
      accountId: "default",
      startClient: false,
    });
    const sharedClient = await acquireSharedMatrixClientMock.mock.results[0]?.value;
    expect(sharedClient.prepareForOneOff).toHaveBeenCalledTimes(1);
    expect(releaseSharedClientInstanceMock).toHaveBeenCalledWith(sharedClient, "stop");
    expect(result).toBe("ok");
  });

  it("reuses active monitor client when available", async () => {
    const activeClient = createMockMatrixClient();
    getActiveMatrixClientMock.mockReturnValue(activeClient);

    const result = await withResolvedMatrixClient({ accountId: "default" }, async (client) => {
      expect(client).toBe(activeClient);
      return "ok";
    });

    expect(result).toBe("ok");
    expect(acquireSharedMatrixClientMock).not.toHaveBeenCalled();
    expect(activeClient.stop).not.toHaveBeenCalled();
  });

  it("uses the effective account id when auth resolution is implicit", async () => {
    resolveMatrixAuthContextMock.mockReturnValue({
      cfg: {},
      env: process.env,
      accountId: "ops",
      resolved: {},
    });
    await withResolvedMatrixClient({}, async () => {});

    expect(getActiveMatrixClientMock).toHaveBeenCalledWith("ops");
    expect(acquireSharedMatrixClientMock).toHaveBeenCalledWith({
      cfg: {},
      timeoutMs: undefined,
      accountId: "ops",
      startClient: false,
    });
  });

  it("uses explicit cfg instead of loading runtime config", async () => {
    const explicitCfg = {
      channels: {
        matrix: {
          defaultAccount: "ops",
        },
      },
    };

    await withResolvedMatrixClient({ cfg: explicitCfg, accountId: "ops" }, async () => {});

    expect(getMatrixRuntimeMock).not.toHaveBeenCalled();
    expect(resolveMatrixAuthContextMock).toHaveBeenCalledWith({
      cfg: explicitCfg,
      accountId: "ops",
    });
    expect(acquireSharedMatrixClientMock).toHaveBeenCalledWith({
      cfg: explicitCfg,
      timeoutMs: undefined,
      accountId: "ops",
      startClient: false,
    });
  });

  it("stops shared matrix clients when wrapped sends fail", async () => {
    const sharedClient = createMockMatrixClient();
    acquireSharedMatrixClientMock.mockResolvedValue(sharedClient);

    await expect(
      withResolvedMatrixClient({ accountId: "default" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(releaseSharedClientInstanceMock).toHaveBeenCalledWith(sharedClient, "stop");
  });
});

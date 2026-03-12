import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockMatrixClient,
  matrixClientResolverMocks,
  primeMatrixClientResolverMocks,
} from "../client-resolver.test-helpers.js";

const {
  getMatrixRuntimeMock,
  getActiveMatrixClientMock,
  resolveSharedMatrixClientMock,
  isBunRuntimeMock,
  resolveMatrixAuthContextMock,
} = matrixClientResolverMocks;

vi.mock("../active-client.js", () => ({
  getActiveMatrixClient: (...args: unknown[]) => getActiveMatrixClientMock(...args),
}));

vi.mock("../client.js", () => ({
  resolveSharedMatrixClient: (...args: unknown[]) => resolveSharedMatrixClientMock(...args),
  isBunRuntime: () => isBunRuntimeMock(),
  resolveMatrixAuthContext: resolveMatrixAuthContextMock,
}));

vi.mock("../../runtime.js", () => ({
  getMatrixRuntime: () => getMatrixRuntimeMock(),
}));

let withResolvedMatrixClient: typeof import("./client.js").withResolvedMatrixClient;

describe("withResolvedMatrixClient", () => {
  beforeEach(async () => {
    vi.resetModules();
    primeMatrixClientResolverMocks({
      resolved: {},
    });

    ({ withResolvedMatrixClient } = await import("./client.js"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reuses the shared client pool when no active monitor client is registered", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", "18799");

    const result = await withResolvedMatrixClient({ accountId: "default" }, async () => "ok");

    expect(getActiveMatrixClientMock).toHaveBeenCalledWith("default");
    expect(resolveSharedMatrixClientMock).toHaveBeenCalledTimes(1);
    expect(resolveSharedMatrixClientMock).toHaveBeenCalledWith({
      cfg: {},
      timeoutMs: undefined,
      accountId: "default",
    });
    const sharedClient = await resolveSharedMatrixClientMock.mock.results[0]?.value;
    expect(sharedClient.prepareForOneOff).toHaveBeenCalledTimes(1);
    expect(sharedClient.stop).not.toHaveBeenCalled();
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
    expect(resolveSharedMatrixClientMock).not.toHaveBeenCalled();
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
    expect(resolveSharedMatrixClientMock).toHaveBeenCalledWith({
      cfg: {},
      timeoutMs: undefined,
      accountId: "ops",
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
    expect(resolveSharedMatrixClientMock).toHaveBeenCalledWith({
      cfg: explicitCfg,
      timeoutMs: undefined,
      accountId: "ops",
    });
  });

  it("keeps shared matrix clients alive when wrapped sends fail", async () => {
    const sharedClient = createMockMatrixClient();
    resolveSharedMatrixClientMock.mockResolvedValue(sharedClient);

    await expect(
      withResolvedMatrixClient({ accountId: "default" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(sharedClient.stop).not.toHaveBeenCalled();
  });
});

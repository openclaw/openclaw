import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockMatrixClient,
  matrixClientResolverMocks,
  primeMatrixClientResolverMocks,
} from "../client-resolver.test-helpers.js";

const resolveMatrixRoomIdMock = vi.fn();

const {
  loadConfigMock,
  getMatrixRuntimeMock,
  getActiveMatrixClientMock,
  resolveSharedMatrixClientMock,
  isBunRuntimeMock,
  resolveMatrixAuthContextMock,
} = matrixClientResolverMocks;

vi.mock("../../runtime.js", () => ({
  getMatrixRuntime: () => getMatrixRuntimeMock(),
}));

vi.mock("../active-client.js", () => ({
  getActiveMatrixClient: getActiveMatrixClientMock,
}));

vi.mock("../client.js", () => ({
  resolveSharedMatrixClient: resolveSharedMatrixClientMock,
  isBunRuntime: () => isBunRuntimeMock(),
  resolveMatrixAuthContext: resolveMatrixAuthContextMock,
}));

vi.mock("../send.js", () => ({
  resolveMatrixRoomId: (...args: unknown[]) => resolveMatrixRoomIdMock(...args),
}));

let withResolvedActionClient: typeof import("./client.js").withResolvedActionClient;
let withResolvedRoomAction: typeof import("./client.js").withResolvedRoomAction;
let withStartedActionClient: typeof import("./client.js").withStartedActionClient;

describe("action client helpers", () => {
  beforeEach(async () => {
    vi.resetModules();
    primeMatrixClientResolverMocks();
    resolveMatrixRoomIdMock
      .mockReset()
      .mockImplementation(async (_client, roomId: string) => roomId);

    ({ withResolvedActionClient, withResolvedRoomAction, withStartedActionClient } =
      await import("./client.js"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reuses the shared client pool when no active monitor client is registered", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_PORT", "18799");

    const result = await withResolvedActionClient({ accountId: "default" }, async () => "ok");

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

  it("skips one-off room preparation when readiness is disabled", async () => {
    await withResolvedActionClient({ accountId: "default", readiness: "none" }, async () => {});

    const sharedClient = await resolveSharedMatrixClientMock.mock.results[0]?.value;
    expect(sharedClient.prepareForOneOff).not.toHaveBeenCalled();
    expect(sharedClient.start).not.toHaveBeenCalled();
    expect(sharedClient.stop).not.toHaveBeenCalled();
  });

  it("starts one-off clients when started readiness is required", async () => {
    await withStartedActionClient({ accountId: "default" }, async () => {});

    const sharedClient = await resolveSharedMatrixClientMock.mock.results[0]?.value;
    expect(sharedClient.start).toHaveBeenCalledTimes(1);
    expect(sharedClient.prepareForOneOff).not.toHaveBeenCalled();
    expect(sharedClient.stop).not.toHaveBeenCalled();
    expect(sharedClient.stopAndPersist).not.toHaveBeenCalled();
  });

  it("reuses active monitor client when available", async () => {
    const activeClient = createMockMatrixClient();
    getActiveMatrixClientMock.mockReturnValue(activeClient);

    const result = await withResolvedActionClient({ accountId: "default" }, async (client) => {
      expect(client).toBe(activeClient);
      return "ok";
    });

    expect(result).toBe("ok");
    expect(resolveSharedMatrixClientMock).not.toHaveBeenCalled();
    expect(activeClient.stop).not.toHaveBeenCalled();
  });

  it("starts active clients when started readiness is required", async () => {
    const activeClient = createMockMatrixClient();
    getActiveMatrixClientMock.mockReturnValue(activeClient);

    await withStartedActionClient({ accountId: "default" }, async (client) => {
      expect(client).toBe(activeClient);
    });

    expect(activeClient.start).toHaveBeenCalledTimes(1);
    expect(activeClient.prepareForOneOff).not.toHaveBeenCalled();
    expect(activeClient.stop).not.toHaveBeenCalled();
    expect(activeClient.stopAndPersist).not.toHaveBeenCalled();
  });

  it("uses the implicit resolved account id for active client lookup and storage", async () => {
    loadConfigMock.mockReturnValue({
      channels: {
        matrix: {
          accounts: {
            ops: {
              homeserver: "https://ops.example.org",
              userId: "@ops:example.org",
              accessToken: "ops-token",
            },
          },
        },
      },
    });
    resolveMatrixAuthContextMock.mockReturnValue({
      cfg: loadConfigMock(),
      env: process.env,
      accountId: "ops",
      resolved: {
        homeserver: "https://ops.example.org",
        userId: "@ops:example.org",
        accessToken: "ops-token",
        deviceId: "OPSDEVICE",
        encryption: true,
      },
    });
    await withResolvedActionClient({}, async () => {});

    expect(getActiveMatrixClientMock).toHaveBeenCalledWith("ops");
    expect(resolveSharedMatrixClientMock).toHaveBeenCalledWith({
      cfg: loadConfigMock(),
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

    await withResolvedActionClient({ cfg: explicitCfg, accountId: "ops" }, async () => {});

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

  it("does not stop shared action clients after wrapped calls succeed", async () => {
    const sharedClient = createMockMatrixClient();
    resolveSharedMatrixClientMock.mockResolvedValue(sharedClient);

    const result = await withResolvedActionClient({ accountId: "default" }, async (client) => {
      expect(client).toBe(sharedClient);
      return "ok";
    });

    expect(result).toBe("ok");
    expect(sharedClient.stop).not.toHaveBeenCalled();
    expect(sharedClient.stopAndPersist).not.toHaveBeenCalled();
  });

  it("keeps shared action clients alive when the wrapped call throws", async () => {
    const sharedClient = createMockMatrixClient();
    resolveSharedMatrixClientMock.mockResolvedValue(sharedClient);

    await expect(
      withResolvedActionClient({ accountId: "default" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(sharedClient.stop).not.toHaveBeenCalled();
    expect(sharedClient.stopAndPersist).not.toHaveBeenCalled();
  });

  it("resolves room ids before running wrapped room actions", async () => {
    const sharedClient = createMockMatrixClient();
    resolveSharedMatrixClientMock.mockResolvedValue(sharedClient);
    resolveMatrixRoomIdMock.mockResolvedValue("!room:example.org");

    const result = await withResolvedRoomAction(
      "room:#ops:example.org",
      { accountId: "default" },
      async (client, resolvedRoom) => {
        expect(client).toBe(sharedClient);
        return resolvedRoom;
      },
    );

    expect(resolveMatrixRoomIdMock).toHaveBeenCalledWith(sharedClient, "room:#ops:example.org");
    expect(result).toBe("!room:example.org");
    expect(sharedClient.stop).not.toHaveBeenCalled();
  });
});

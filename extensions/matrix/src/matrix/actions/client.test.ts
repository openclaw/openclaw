// Matrix tests cover client plugin behavior.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockMatrixClient,
  expectExplicitMatrixClientConfig,
  expectOneOffSharedMatrixClient,
  matrixClientResolverMocks,
  primeMatrixClientResolverMocks,
  setAcquiredMatrixClient,
} from "../client-resolver.test-helpers.js";

const resolveMatrixRoomIdMock = vi.fn();

const { getMatrixRuntimeMock, acquireSharedMatrixClientMock, sharedLeaseReleaseMock } =
  matrixClientResolverMocks;

const TEST_CFG = {};

vi.mock("../../runtime.js", () => ({
  getMatrixRuntime: () => getMatrixRuntimeMock(),
}));

// mock-isolation: Lease fixtures replace shared network/crypto client ownership.
vi.mock("../client.js", () => ({
  acquireSharedMatrixClient: acquireSharedMatrixClientMock,
}));

vi.mock("../send.js", () => ({
  resolveMatrixRoomId: (...args: unknown[]) => resolveMatrixRoomIdMock(...args),
}));

let withResolvedActionClient: typeof import("./client.js").withResolvedActionClient;
let withResolvedRoomAction: typeof import("./client.js").withResolvedRoomAction;
let withStartedActionClient: typeof import("./client.js").withStartedActionClient;

describe("action client lazy loading", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock("../client-bootstrap.js");
    vi.resetModules();
  });

  it("defers bootstrap evaluation until action work starts", async () => {
    const evaluateBootstrap = vi.fn(async () =>
      vi.importActual<typeof import("../client-bootstrap.js")>("../client-bootstrap.js"),
    );
    vi.doMock("../client-bootstrap.js", evaluateBootstrap);

    const { withResolvedActionClient: runAction } = await import("./client.js");
    expect(evaluateBootstrap).not.toHaveBeenCalled();

    const client = createMockMatrixClient();
    const run = vi.fn(async () => "first result");
    await expect(runAction({ client }, run)).resolves.toBe("first result");
    expect(run).toHaveBeenCalledWith(client, undefined);
    expect(evaluateBootstrap).toHaveBeenCalledTimes(1);

    const failure = new Error("action failed");
    await expect(
      runAction({ client }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(evaluateBootstrap).toHaveBeenCalledTimes(1);
  });
});

describe("action client helpers", () => {
  beforeAll(async () => {
    ({ withResolvedActionClient, withResolvedRoomAction, withStartedActionClient } =
      await import("./client.js"));
  });

  beforeEach(() => {
    primeMatrixClientResolverMocks();
    resolveMatrixRoomIdMock
      .mockReset()
      .mockImplementation(async (_client, roomId: string) => roomId);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("starts through the lease and persists started action clients", async () => {
    await withStartedActionClient({ cfg: TEST_CFG, accountId: "default" }, async () => {});

    await expectOneOffSharedMatrixClient({
      prepareForOneOffCalls: 0,
      startCalls: 1,
      releaseMode: "persist",
    });
  });

  it("leaves implicit account selection to the shared client owner", async () => {
    await withResolvedActionClient({ cfg: TEST_CFG }, async () => {});

    expect(acquireSharedMatrixClientMock).toHaveBeenCalledExactlyOnceWith({
      cfg: TEST_CFG,
      timeoutMs: undefined,
      accountId: undefined,
      startClient: false,
      role: "transient",
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

    expectExplicitMatrixClientConfig({
      cfg: explicitCfg,
      accountId: "ops",
    });
  });

  it("releases shared action clients when the wrapped call throws", async () => {
    const sharedClient = createMockMatrixClient();
    setAcquiredMatrixClient(sharedClient);

    await expect(
      withResolvedActionClient({ cfg: TEST_CFG, accountId: "default" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(sharedLeaseReleaseMock).toHaveBeenCalledWith({ mode: "persist" });
  });

  it("resolves room ids before running wrapped room actions", async () => {
    const sharedClient = createMockMatrixClient();
    const lease = setAcquiredMatrixClient(sharedClient);
    resolveMatrixRoomIdMock.mockResolvedValue("!room:example.org");

    const result = await withResolvedRoomAction(
      "room:#ops:example.org",
      { cfg: TEST_CFG, accountId: "default" },
      async (client, resolvedRoom, abortSignal) => {
        expect(client).toBe(sharedClient);
        expect(abortSignal).toBe(lease.abortSignal);
        return resolvedRoom;
      },
    );

    expect(resolveMatrixRoomIdMock).toHaveBeenCalledWith(sharedClient, "room:#ops:example.org");
    expect(result).toBe("!room:example.org");
    expect(sharedLeaseReleaseMock).toHaveBeenCalledWith({ mode: "persist" });
  });
});

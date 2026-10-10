// Matrix tests cover client bootstrap plugin behavior.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { awaitGateBeforeSettlement } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMockMatrixClient,
  matrixClientResolverMocks,
  primeMatrixClientResolverMocks,
  setAcquiredMatrixClient,
} from "./client-resolver.test-helpers.js";

const {
  getMatrixRuntimeMock,
  acquireSharedMatrixClientMock,
  sharedLeaseReleaseMock,
  resolveMatrixAuthContextMock,
} = matrixClientResolverMocks;

const TEST_CFG = {};
const captureAuthority = vi.hoisted(() => vi.fn<() => (() => void) | undefined>(() => undefined));

// mock-isolation: Supply the caller assertion without starting host/network runtime.
vi.mock("openclaw/plugin-sdk/fetch-runtime", () => ({
  captureChannelReadAuthority: captureAuthority,
}));

vi.mock("../runtime.js", () => ({
  getMatrixRuntime: () => getMatrixRuntimeMock(),
}));

vi.mock("./client.js", () => ({
  acquireSharedMatrixClient: (...args: unknown[]) => acquireSharedMatrixClientMock(...args),
  resolveMatrixAuthContext: resolveMatrixAuthContextMock,
}));

let resolveRuntimeMatrixClientWithReadiness: typeof import("./client-bootstrap.js").resolveRuntimeMatrixClientWithReadiness;
let withResolvedRuntimeMatrixClient: typeof import("./client-bootstrap.js").withResolvedRuntimeMatrixClient;

describe("client bootstrap", () => {
  beforeAll(async () => {
    ({ resolveRuntimeMatrixClientWithReadiness, withResolvedRuntimeMatrixClient } =
      await import("./client-bootstrap.js"));
  });

  beforeEach(() => {
    primeMatrixClientResolverMocks({ resolved: {} });
    captureAuthority.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("releases leased shared clients when readiness setup fails", async () => {
    const prepareForOneOff = vi.fn(async () => undefined);
    const sharedClient = Object.assign(createMockMatrixClient(), { prepareForOneOff });
    prepareForOneOff.mockRejectedValue(new Error("prepare failed"));
    setAcquiredMatrixClient(sharedClient);

    await expect(
      resolveRuntimeMatrixClientWithReadiness({
        cfg: TEST_CFG,
        accountId: "default",
        readiness: "prepared",
      }),
    ).rejects.toThrow("prepare failed");

    expect(sharedLeaseReleaseMock).toHaveBeenCalledWith({ mode: "stop" });
  });

  it("starts through the shared lease and releases when startup fails", async () => {
    const start = vi.fn(async () => undefined);
    const sharedClient = Object.assign(createMockMatrixClient(), { start });
    start.mockRejectedValue(new Error("start failed"));
    setAcquiredMatrixClient(sharedClient);

    await expect(
      withResolvedRuntimeMatrixClient(
        {
          cfg: TEST_CFG,
          accountId: "default",
          readiness: "started",
        },
        async () => "ok",
      ),
    ).rejects.toThrow("start failed");

    expect(sharedLeaseReleaseMock).toHaveBeenCalledWith({ mode: "stop" });
  });

  it("borrows every non-injected client from the shared owner", async () => {
    const sharedClient = createMockMatrixClient();
    setAcquiredMatrixClient(sharedClient);

    await withResolvedRuntimeMatrixClient(
      { cfg: TEST_CFG, accountId: "default", readiness: "none" },
      async (client) => {
        expect(client).toBe(sharedClient);
      },
      "persist",
    );

    expect(acquireSharedMatrixClientMock).toHaveBeenCalledWith({
      cfg: TEST_CFG,
      timeoutMs: undefined,
      accountId: "default",
      startClient: false,
      role: "transient",
    });
    expect(sharedLeaseReleaseMock).toHaveBeenCalledWith({ mode: "persist" });
  });

  it("passes the transient retirement signal to admitted work", async () => {
    const sharedClient = createMockMatrixClient();
    const lease = setAcquiredMatrixClient(sharedClient);

    await withResolvedRuntimeMatrixClient(
      { cfg: TEST_CFG, accountId: "default", readiness: "none" },
      async (client, abortSignal) => {
        expect(client).toBe(sharedClient);
        expect(abortSignal).toBe(lease.abortSignal);
      },
    );
  });

  it("does not borrow or stop an explicitly injected client", async () => {
    const start = vi.fn(async () => undefined);
    const injected = Object.assign(createMockMatrixClient(), { start });

    await withResolvedRuntimeMatrixClient(
      { client: injected, readiness: "started" },
      async (client) => {
        expect(client).toBe(injected);
      },
      "persist",
    );

    expect(start).toHaveBeenCalledTimes(1);
    expect(acquireSharedMatrixClientMock).not.toHaveBeenCalled();
    expect(sharedLeaseReleaseMock).not.toHaveBeenCalled();
  });

  it("settles accepted crypto persistence before refusing a revoked caller's result", async () => {
    const persistenceEntered = createDeferred<void>();
    const persist = createDeferred<void>();
    const events: string[] = [];
    let current = true;
    captureAuthority.mockReturnValue(() => {
      if (!current) {
        throw new Error("fixture caller revoked");
      }
    });
    sharedLeaseReleaseMock.mockImplementationOnce(async () => {
      persistenceEntered.resolve();
      await persist.promise;
      events.push("crypto persisted");
    });
    let settled = false;
    const operation = withResolvedRuntimeMatrixClient(
      { cfg: TEST_CFG, accountId: "default", readiness: "none" },
      async () => {
        current = false;
        return "must not disclose";
      },
      "persist",
    ).then(
      () => {
        throw new Error("Revoked result escaped");
      },
      (error: unknown) => {
        settled = true;
        events.push("request rejected");
        return error;
      },
    );
    try {
      await awaitGateBeforeSettlement(
        persistenceEntered.promise,
        operation,
        "Persistence did not begin",
      );
      expect(settled).toBe(false);
      expect(sharedLeaseReleaseMock).toHaveBeenCalledWith({ mode: "persist" });
    } finally {
      persist.resolve();
      await Promise.allSettled([operation]);
    }
    expect(await operation).toMatchObject({ message: "fixture caller revoked" });
    expect(events).toEqual(["crypto persisted", "request rejected"]);
  });
});

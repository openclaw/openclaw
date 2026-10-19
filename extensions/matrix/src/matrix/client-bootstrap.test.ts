import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { awaitGateBeforeSettlement } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
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

const options = { cfg: {}, accountId: "default", readiness: "none" as const };
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

beforeAll(async () => {
  ({ resolveRuntimeMatrixClientWithReadiness, withResolvedRuntimeMatrixClient } =
    await import("./client-bootstrap.js"));
});

beforeEach(() => {
  primeMatrixClientResolverMocks();
  captureAuthority.mockReturnValue(undefined);
});

it.each(["prepared", "started"] as const)(
  "persists after %s readiness fails",
  async (readiness) => {
    const failure = new Error("readiness failed");
    const fail = vi.fn<() => Promise<void>>().mockRejectedValue(failure);
    const method = readiness === "prepared" ? "prepareForOneOff" : "start";
    setAcquiredMatrixClient(Object.assign(createMockMatrixClient(), { [method]: fail }));
    const opts = { ...options, readiness };
    await expect(
      readiness === "prepared"
        ? resolveRuntimeMatrixClientWithReadiness(opts)
        : withResolvedRuntimeMatrixClient(opts, async () => "ok"),
    ).rejects.toBe(failure);
    expect(sharedLeaseReleaseMock).toHaveBeenCalledWith({ mode: "persist" });
  },
);

it("borrows the shared client and passes its transient retirement signal", async () => {
  const sharedClient = createMockMatrixClient();
  const lease = setAcquiredMatrixClient(sharedClient);

  await withResolvedRuntimeMatrixClient(options, async (client, abortSignal) => {
    expect(client).toBe(sharedClient);
    expect(abortSignal).toBe(lease.abortSignal);
  });

  expect(acquireSharedMatrixClientMock).toHaveBeenCalledWith({
    cfg: options.cfg,
    timeoutMs: undefined,
    accountId: "default",
    startClient: false,
    role: "transient",
  });
  expect(sharedLeaseReleaseMock).toHaveBeenCalledWith({ mode: "persist" });
});

it("rejects a completed action when final crypto persistence fails", async () => {
  const failure = new Error("final snapshot failed");
  sharedLeaseReleaseMock.mockRejectedValueOnce(failure);

  await expect(
    withResolvedRuntimeMatrixClient(
      { ...options, readiness: "prepared" },
      async () => "action completed",
    ),
  ).rejects.toBe(failure);
  expect(sharedLeaseReleaseMock).toHaveBeenCalledWith({ mode: "persist" });
});

it("does not borrow or stop an explicitly injected client", async () => {
  const injected = createMockMatrixClient();

  await withResolvedRuntimeMatrixClient(
    { client: injected, readiness: "started" },
    async (client) => expect(client).toBe(injected),
  );

  expect(injected.start).toHaveBeenCalledTimes(1);
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
  const operation = withResolvedRuntimeMatrixClient(options, async () => {
    current = false;
    return "must not disclose";
  }).catch((error: unknown) => {
    events.push("request rejected");
    return error;
  });
  try {
    await awaitGateBeforeSettlement(
      persistenceEntered.promise,
      operation,
      "Persistence did not begin",
    );
    expect(events).toEqual([]);
    expect(sharedLeaseReleaseMock).toHaveBeenCalledWith({ mode: "persist" });
  } finally {
    persist.resolve();
    await Promise.allSettled([operation]);
  }
  expect(await operation).toMatchObject({ message: "fixture caller revoked" });
  expect(events).toEqual(["crypto persisted", "request rejected"]);
});

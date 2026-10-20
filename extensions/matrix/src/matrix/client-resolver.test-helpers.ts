// Matrix helper module supports client resolver helpers behavior.
import { expect, vi, type Mock } from "vitest";
import type { SharedMatrixClientLease } from "./client/shared.js";
import type { MatrixClient } from "./sdk.js";

type MatrixClientResolverMocks = {
  getMatrixRuntimeMock: Mock<() => unknown>;
  acquireSharedMatrixClientMock: Mock<(...args: unknown[]) => Promise<SharedMatrixClientLease>>;
  sharedLeaseReleaseMock: Mock<(...args: unknown[]) => Promise<void>>;
  sharedLeaseStartMock: Mock<(...args: unknown[]) => Promise<void>>;
};

export const matrixClientResolverMocks: MatrixClientResolverMocks = {
  getMatrixRuntimeMock: vi.fn(),
  acquireSharedMatrixClientMock: vi.fn(),
  sharedLeaseReleaseMock: vi.fn(),
  sharedLeaseStartMock: vi.fn(),
};

export function createMockMatrixClient(): MatrixClient {
  return {
    prepareForOneOff: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    stop: vi.fn(() => undefined),
    stopAndPersist: vi.fn(async () => undefined),
    stopWithoutPersist: vi.fn(async () => undefined),
  } as unknown as MatrixClient;
}

export function setAcquiredMatrixClient(client: MatrixClient): SharedMatrixClientLease {
  const { acquireSharedMatrixClientMock, sharedLeaseReleaseMock, sharedLeaseStartMock } =
    matrixClientResolverMocks;
  sharedLeaseStartMock.mockImplementation(async () => {
    await client.start();
  });
  const lease: SharedMatrixClientLease = {
    abortSignal: new AbortController().signal,
    client,
    role: "transient",
    registerMonitorRetirement: vi.fn(),
    start: sharedLeaseStartMock,
    release: sharedLeaseReleaseMock,
  };
  acquireSharedMatrixClientMock.mockResolvedValue(lease);
  return lease;
}

export function primeMatrixClientResolverMocks() {
  const { acquireSharedMatrixClientMock, sharedLeaseReleaseMock, sharedLeaseStartMock } =
    matrixClientResolverMocks;

  vi.clearAllMocks();
  sharedLeaseReleaseMock.mockReset().mockResolvedValue(undefined);
  sharedLeaseStartMock.mockReset();
  acquireSharedMatrixClientMock.mockReset();
  setAcquiredMatrixClient(createMockMatrixClient());
}

export async function expectOneOffSharedMatrixClient(params?: {
  cfg?: unknown;
  accountId?: string;
  timeoutMs?: number;
  prepareForOneOffCalls?: number;
  startCalls?: number;
  releaseMode?: "persist" | "stop" | "discard";
}) {
  const { acquireSharedMatrixClientMock, sharedLeaseReleaseMock } = matrixClientResolverMocks;
  const accountId = params?.accountId ?? "default";
  const prepareForOneOffCalls = params?.prepareForOneOffCalls ?? 1;
  const startCalls = params?.startCalls ?? 0;
  const releaseMode = params?.releaseMode ?? "persist";

  expect(acquireSharedMatrixClientMock).toHaveBeenCalledTimes(1);
  expect(acquireSharedMatrixClientMock).toHaveBeenCalledWith({
    cfg: params?.cfg ?? {},
    timeoutMs: params?.timeoutMs,
    accountId,
    startClient: false,
    role: "transient",
  });

  const lease = await acquireSharedMatrixClientMock.mock.results[0]?.value;
  expect(lease.client.prepareForOneOff).toHaveBeenCalledTimes(prepareForOneOffCalls);
  expect(lease.client.start).toHaveBeenCalledTimes(startCalls);
  expect(sharedLeaseReleaseMock).toHaveBeenCalledWith({ mode: releaseMode });

  return lease.client;
}

export function expectExplicitMatrixClientConfig(params: { cfg: unknown; accountId?: string }) {
  const { getMatrixRuntimeMock, acquireSharedMatrixClientMock } = matrixClientResolverMocks;
  const accountId = params.accountId ?? "default";

  expect(getMatrixRuntimeMock).not.toHaveBeenCalled();
  expect(acquireSharedMatrixClientMock).toHaveBeenCalledWith({
    cfg: params.cfg,
    timeoutMs: undefined,
    accountId,
    startClient: false,
    role: "transient",
  });
}

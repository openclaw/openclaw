import { expect, vi } from "vitest";
import type { SharedMatrixClientLease } from "./client/shared.js";
import type { MatrixClient } from "./sdk.js";

export const matrixClientResolverMocks = {
  getMatrixRuntimeMock: vi.fn<() => unknown>(),
  acquireSharedMatrixClientMock: vi.fn<(...args: unknown[]) => Promise<SharedMatrixClientLease>>(),
  sharedLeaseReleaseMock: vi.fn<(...args: unknown[]) => Promise<void>>(),
  sharedLeaseStartMock: vi.fn<(...args: unknown[]) => Promise<void>>(),
};
const { acquireSharedMatrixClientMock, sharedLeaseReleaseMock, sharedLeaseStartMock } =
  matrixClientResolverMocks;

export function createMockMatrixClient(): MatrixClient {
  return {
    prepareForOneOff: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
  } as unknown as MatrixClient;
}

export function setAcquiredMatrixClient(client: MatrixClient): SharedMatrixClientLease {
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
  vi.clearAllMocks();
  sharedLeaseReleaseMock.mockReset().mockResolvedValue(undefined);
  sharedLeaseStartMock.mockReset();
  acquireSharedMatrixClientMock.mockReset();
  setAcquiredMatrixClient(createMockMatrixClient());
}

export async function expectOneOffSharedMatrixClient(params?: {
  prepareForOneOffCalls?: number;
  startCalls?: number;
  releaseMode?: "persist" | "stop" | "discard";
}) {
  expect(acquireSharedMatrixClientMock).toHaveBeenCalledExactlyOnceWith({
    cfg: {},
    timeoutMs: undefined,
    accountId: "default",
    role: "transient",
  });

  const lease = await acquireSharedMatrixClientMock.mock.results[0]?.value;
  expect(lease.client.prepareForOneOff).toHaveBeenCalledTimes(params?.prepareForOneOffCalls ?? 1);
  expect(lease.client.start).toHaveBeenCalledTimes(params?.startCalls ?? 0);
  expect(sharedLeaseReleaseMock).toHaveBeenCalledWith({ mode: params?.releaseMode ?? "persist" });
}

export function expectExplicitMatrixClientConfig(params: { cfg: unknown; accountId?: string }) {
  expect(matrixClientResolverMocks.getMatrixRuntimeMock).not.toHaveBeenCalled();
  expect(acquireSharedMatrixClientMock).toHaveBeenCalledWith({
    cfg: params.cfg,
    timeoutMs: undefined,
    accountId: params.accountId ?? "default",
    role: "transient",
  });
}

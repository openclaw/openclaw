import { vi, type Mock } from "vitest";

type MockMemorySearchManager = {
  manager: {
    sync: (params?: unknown) => Promise<void>;
  };
};

export const getMemorySearchManagerMock: Mock<
  (params?: unknown) => Promise<MockMemorySearchManager>
> = vi.fn(async () => ({ manager: { sync: vi.fn(async () => {}) } }));

export const getMemoryProviderMock = vi.fn();

/** The native provider runtime a test reports as already loaded, if any. */
export const getMemoryProviderRuntimeMock = vi.fn<() => { open: () => unknown } | undefined>(
  () => undefined,
);

export const resolveMemorySearchConfigMock = vi.fn(() => ({
  sources: ["sessions"],
  sync: { sessions: { postCompactionForce: true } },
}));

/** Restores the memory runtime mocks shared by compact hook tests. */
export function resetCompactMemoryMocks(): void {
  getMemorySearchManagerMock.mockReset();
  getMemorySearchManagerMock.mockResolvedValue({
    manager: { sync: vi.fn(async () => {}) },
  });
  getMemoryProviderMock.mockReset();
  getMemoryProviderRuntimeMock.mockReset().mockReturnValue(undefined);
  resolveMemorySearchConfigMock.mockReset().mockReturnValue({
    sources: ["sessions"],
    sync: { sessions: { postCompactionForce: true } },
  });
}

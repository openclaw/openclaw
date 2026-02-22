import type { Mock } from "vitest";
import { afterEach, beforeEach, vi } from "vitest";

export function resolveBlueBubblesAccountFromConfig(params: {
  cfg?: { channels?: { bluebubbles?: Record<string, unknown> } };
  accountId?: string;
}) {
  const config = params.cfg?.channels?.bluebubbles ?? {};
  return {
    accountId: params.accountId ?? "default",
    enabled: config.enabled !== false,
    configured: Boolean(config.serverUrl && config.password),
    config,
  };
}

export function createBlueBubblesAccountsMockModule() {
  return {
    resolveBlueBubblesAccount: vi.fn(resolveBlueBubblesAccountFromConfig),
  };
}

type BlueBubblesProbeMockModule = {
  getCachedBlueBubblesPrivateApiStatus: Mock<() => boolean | null>;
};

export function createBlueBubblesProbeMockModule(): BlueBubblesProbeMockModule {
  return {
    getCachedBlueBubblesPrivateApiStatus: vi.fn().mockReturnValue(null),
  };
}

export function installBlueBubblesFetchTestHooks(params: {
  mockFetch: ReturnType<typeof vi.fn>;
  privateApiStatusMock: {
    mockReset: () => unknown;
    mockReturnValue: (value: boolean | null) => unknown;
  };
}) {
  beforeEach(() => {
    vi.stubGlobal("fetch", params.mockFetch);
    params.mockFetch.mockReset();
    params.privateApiStatusMock.mockReset();
    params.privateApiStatusMock.mockReturnValue(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
}

import type { Mock } from "vitest";
import { afterEach, beforeEach, vi } from "vitest";

export const BLUE_BUBBLES_PRIVATE_API_STATUS: {
  enabled: true;
  disabled: false;
  unknown: null;
} = {
  enabled: true,
  disabled: false,
  unknown: null,
};

type BlueBubblesPrivateApiStatusMock = {
  mockReturnValue: (value: boolean | null) => unknown;
  mockReturnValueOnce: (value: boolean | null) => unknown;
};

export function mockBlueBubblesPrivateApiStatus(
  mock: Pick<BlueBubblesPrivateApiStatusMock, "mockReturnValue">,
  value: boolean | null,
) {
  mock.mockReturnValue(value);
}

export function mockBlueBubblesPrivateApiStatusOnce(
  mock: Pick<BlueBubblesPrivateApiStatusMock, "mockReturnValueOnce">,
  value: boolean | null,
) {
  mock.mockReturnValueOnce(value);
}

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
  isBlueBubblesPrivateApiStatusEnabled: Mock<(status: boolean | null) => boolean>;
};

export function createBlueBubblesProbeMockModule(): BlueBubblesProbeMockModule {
  return {
    getCachedBlueBubblesPrivateApiStatus: vi
      .fn()
      .mockReturnValue(BLUE_BUBBLES_PRIVATE_API_STATUS.unknown),
    isBlueBubblesPrivateApiStatusEnabled: vi.fn((status: boolean | null) => status === true),
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
    params.privateApiStatusMock.mockReturnValue(BLUE_BUBBLES_PRIVATE_API_STATUS.unknown);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });
}

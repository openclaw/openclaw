import { afterEach, beforeEach, vi } from "vitest";
const BLUE_BUBBLES_PRIVATE_API_STATUS = {
  enabled: true,
  disabled: false,
  unknown: null
};
function mockBlueBubblesPrivateApiStatus(mock, value) {
  mock.mockReturnValue(value);
}
function mockBlueBubblesPrivateApiStatusOnce(mock, value) {
  mock.mockReturnValueOnce(value);
}
function resolveBlueBubblesAccountFromConfig(params) {
  const config = params.cfg?.channels?.bluebubbles ?? {};
  return {
    accountId: params.accountId ?? "default",
    enabled: config.enabled !== false,
    configured: Boolean(config.serverUrl && config.password),
    config
  };
}
function createBlueBubblesAccountsMockModule() {
  return {
    resolveBlueBubblesAccount: vi.fn(resolveBlueBubblesAccountFromConfig)
  };
}
function createBlueBubblesProbeMockModule() {
  return {
    getCachedBlueBubblesPrivateApiStatus: vi.fn().mockReturnValue(BLUE_BUBBLES_PRIVATE_API_STATUS.unknown),
    isBlueBubblesPrivateApiStatusEnabled: vi.fn((status) => status === true)
  };
}
function installBlueBubblesFetchTestHooks(params) {
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
export {
  BLUE_BUBBLES_PRIVATE_API_STATUS,
  createBlueBubblesAccountsMockModule,
  createBlueBubblesProbeMockModule,
  installBlueBubblesFetchTestHooks,
  mockBlueBubblesPrivateApiStatus,
  mockBlueBubblesPrivateApiStatusOnce,
  resolveBlueBubblesAccountFromConfig
};

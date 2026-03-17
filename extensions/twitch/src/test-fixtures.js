import { afterEach, beforeEach, vi } from "vitest";
const BASE_TWITCH_TEST_ACCOUNT = {
  username: "testbot",
  clientId: "test-client-id",
  channel: "#testchannel"
};
function makeTwitchTestConfig(account) {
  return {
    channels: {
      twitch: {
        accounts: {
          default: account
        }
      }
    }
  };
}
function installTwitchTestHooks() {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });
}
export {
  BASE_TWITCH_TEST_ACCOUNT,
  installTwitchTestHooks,
  makeTwitchTestConfig
};

import { describe, expect, it, vi } from "vitest";

vi.mock("@slack/bolt", () => {
  class SocketModeReceiver {
    requestListener = vi.fn();
  }
  class HTTPReceiver {
    requestListener = vi.fn();
  }
  class App {
    receiver: unknown;
    constructor(opts: { receiver?: unknown } = {}) {
      this.receiver = opts.receiver;
    }
    use = vi.fn();
    event = vi.fn();
    message = vi.fn();
    action = vi.fn();
    shortcut = vi.fn();
    command = vi.fn();
    error = vi.fn();
    start = vi.fn().mockRejectedValue(new Error("An API error occurred: account_inactive"));
    stop = vi.fn().mockResolvedValue(undefined);
  }
  return { default: App, App, HTTPReceiver, SocketModeReceiver };
});

vi.mock("../accounts.js", () => ({
  resolveSlackAccount: vi.fn().mockReturnValue({
    accountId: "default",
    enabled: true,
    botToken: "xoxb-test",
    appToken: "xapp-test",
    config: { mode: "socket" },
  }),
}));

vi.mock("../client.js", () => ({
  resolveSlackWebClientOptions: vi.fn().mockReturnValue({}),
}));

import { monitorSlackProvider } from "./provider.js";

describe("monitorSlackProvider - gateway crash prevention", () => {
  it("resolves instead of rejecting on non-recoverable auth error", async () => {
    await expect(
      monitorSlackProvider({
        botToken: "xoxb-test",
        appToken: "xapp-test",
        accountId: "default",
      }),
    ).resolves.toBeUndefined();
  });
});

import { describe, it, expect, vi } from "vitest";
import { monitorSlackProvider } from "./provider.js";

vi.mock("@slack/bolt", () => {
  class App {
    client = {
      auth: {
        test: vi.fn().mockResolvedValue({ user_id: "U123", team_id: "T123", api_app_id: "A123" }),
      },
    };
    start = vi.fn().mockRejectedValue(new Error("An API error occurred: account_inactive"));
    stop = vi.fn().mockResolvedValue(undefined);
    event = vi.fn();
    message = vi.fn();
    action = vi.fn();
    shortcut = vi.fn();
    command = vi.fn();
    error = vi.fn();
  }
  class HTTPReceiver {}
  return { default: App, App, HTTPReceiver };
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

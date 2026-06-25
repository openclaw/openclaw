// Slack tests cover auth.test token handling during provider boot.
import { beforeEach, describe, expect, it } from "vitest";
import {
  getSlackClient,
  resetSlackTestState,
  startSlackMonitor,
  stopSlackMonitor,
} from "../monitor.test-helpers.js";

const { monitorSlackProvider } = await import("./provider.js");

beforeEach(() => {
  resetSlackTestState();
});

describe("auth.test boot call", () => {
  it("does not pass the bot token in the call arguments", async () => {
    const monitor = startSlackMonitor(monitorSlackProvider);
    await stopSlackMonitor(monitor);

    const client = getSlackClient();
    expect(client.auth.test).toHaveBeenCalledTimes(1);
    // The SDK serializes every property from the call argument into the POST
    // body.  Passing { token } would leak the bot token into the request
    // payload alongside the Authorization header.
    const firstArg = client.auth.test.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    if (firstArg != null) {
      expect(firstArg).not.toHaveProperty("token");
    }
  });
});

import { describe, expect, it } from "vitest";
import { createSlackSendTestClient, installSlackBlockTestMocks } from "./blocks.test-helpers.js";
import { clearSlackRuntime, setSlackRuntime } from "./runtime.js";

installSlackBlockTestMocks();
const { sendMessageSlack } = await import("./send.js");

describe("sendMessageSlack runtime config", () => {
  it("uses the loaded runtime config instead of a stale passed cfg", async () => {
    const client = createSlackSendTestClient();
    const runtimeCfg = {
      channels: {
        slack: {
          accounts: {
            default: {
              botToken: "xoxb-runtime",
            },
          },
        },
      },
    };
    setSlackRuntime({
      config: {
        loadConfig: () => runtimeCfg,
      },
    } as never);

    try {
      await sendMessageSlack("channel:C123", "hello", {
        cfg: {},
        client,
      });

      expect(client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "C123",
          text: "hello",
        }),
      );
    } finally {
      clearSlackRuntime();
    }
  });
});

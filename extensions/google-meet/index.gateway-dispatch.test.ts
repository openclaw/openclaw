import * as gatewayRuntime from "openclaw/plugin-sdk/gateway-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { getMeetTool, setupGoogleMeetPlugin } from "./src/test-support/plugin-harness.js";

describe("Google Meet tool Gateway dispatch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["hosted", "standalone"])(
    "returns %s Gateway errors without redispatching",
    async (route) => {
      const hosted = route === "hosted";
      const { tools, gatewayRequest } = setupGoogleMeetPlugin(
        plugin,
        {},
        { gatewayAvailable: true, toolContext: { agentId: hosted ? "support" : "main" } },
      );
      gatewayRequest.mockResolvedValue({});
      const cliRequest = vi.spyOn(gatewayRuntime, "callGatewayFromCli").mockResolvedValue({});
      const selected = hosted ? gatewayRequest : cliRequest;
      const other = hosted ? cliRequest : gatewayRequest;
      const details = { error: "Admit the guest", manualActionRequired: true };
      selected
        .mockRejectedValueOnce(Object.assign(new Error("Waiting for admission"), { details }))
        .mockRejectedValueOnce(new Error("Room is closed"));
      const tool = getMeetTool({ tools });
      const request = {
        action: "join",
        url: "https://meet.google.com/abc-defg-hij",
        mode: "transcribe",
      } as const;

      expect((await tool.execute("admission", request)).details).toEqual(details);
      expect((await tool.execute("closed", request)).details).toEqual({ error: "Room is closed" });
      expect(selected).toHaveBeenCalledTimes(2);
      expect(other).not.toHaveBeenCalled();
    },
  );
});

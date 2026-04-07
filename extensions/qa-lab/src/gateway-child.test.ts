import { describe, expect, it } from "vitest";
import { __testing } from "./gateway-child.js";

describe("qa gateway child runtime env", () => {
  it("allows normal reply config flows while keeping fast test mode", () => {
    const env = __testing.buildQaRuntimeEnv({
      configPath: "/tmp/openclaw.json",
      gatewayToken: "qa-suite-token",
      homeDir: "/tmp/home",
      stateDir: "/tmp/state",
      xdgConfigHome: "/tmp/xdg-config",
      xdgDataHome: "/tmp/xdg-data",
      xdgCacheHome: "/tmp/xdg-cache",
      providerMode: "mock-openai",
    });

    expect(env.OPENCLAW_TEST_FAST).toBe("1");
    expect(env.OPENCLAW_ALLOW_SLOW_REPLY_TESTS).toBe("1");
  });
});

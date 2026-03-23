import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { monitorLineProvider } from "./monitor.js";

describe("monitorLineProvider fail-closed webhook auth", () => {
  it("rejects startup when channel secret is missing", async () => {
    await expect(
      monitorLineProvider({
        channelAccessToken: "token",
        channelSecret: "   ",
        config: {} as OpenClawConfig,
        runtime: {} as RuntimeEnv,
      }),
    ).rejects.toThrow("LINE webhook mode requires a non-empty channel secret.");
  });

  it("rejects startup when channel access token is missing", async () => {
    await expect(
      monitorLineProvider({
        channelAccessToken: "   ",
        channelSecret: "secret",
        config: {} as OpenClawConfig,
        runtime: {} as RuntimeEnv,
      }),
    ).rejects.toThrow("LINE webhook mode requires a non-empty channel access token.");
  });
});

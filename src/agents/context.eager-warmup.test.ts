import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: loadConfigMock,
  };
});

describe("agents/context eager warmup", () => {
  const originalArgv = process.argv.slice();

  beforeEach(() => {
    vi.resetModules();
    loadConfigMock.mockReset();
  });

  afterEach(() => {
    process.argv = originalArgv.slice();
  });

  it.each([
    ["models", ["node", "openclaw", "models", "set", "openai/gpt-5.4"]],
    ["agent", ["node", "openclaw", "agent", "--message", "ok"]],
  ])("does not eager-load config for %s commands on import", async (_label, argv) => {
    process.argv = argv;
    await import("./context.js");

    expect(loadConfigMock).not.toHaveBeenCalled();
  });

  it("does not eager-load config when onboard imports command-auth through plugin-sdk", async () => {
    process.argv = ["node", "openclaw", "onboard"];

    await import("../plugin-sdk/command-auth.js");

    expect(loadConfigMock).not.toHaveBeenCalled();
  });

  it("does not eager-load config when pairing approve imports command-auth through plugin-sdk", async () => {
    process.argv = ["node", "openclaw", "pairing", "approve", "feishu", "BAH8YVB3"];

    await import("../plugin-sdk/command-auth.js");

    expect(loadConfigMock).not.toHaveBeenCalled();
  });

  it("does not eager-load config when channels login imports command-auth through plugin-sdk", async () => {
    process.argv = ["node", "openclaw", "channels", "login", "--channel", "openclaw-weixin"];

    await import("../plugin-sdk/command-auth.js");

    expect(loadConfigMock).not.toHaveBeenCalled();
  });
});

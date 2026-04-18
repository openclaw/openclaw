import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", () => ({ loadConfig: loadConfigMock }));

describe("agents/context eager warmup", () => {
  const originalArgv = process.argv.slice();

  beforeEach(() => {
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
    vi.resetModules();
    await import("./context.js");

    expect(loadConfigMock).not.toHaveBeenCalled();
  });

  it("does not eager-load config when plugin-sdk command-auth is imported", async () => {
    process.argv = ["node", "openclaw", "onboard"];
    vi.resetModules();
    await import("../plugin-sdk/command-auth.js");

    expect(loadConfigMock).not.toHaveBeenCalled();
  });
});

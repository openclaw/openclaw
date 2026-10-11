import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn(),
  log: vi.fn(),
  error: vi.fn(),
  writeJson: vi.fn(),
  exit: vi.fn(),
}));

// mock-isolation: Keep Gateway transport and host state outside this CLI routing fixture.
vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  callGatewayFromCli: mocks.callGatewayFromCli,
  addGatewayClientOptions: (command: Command) => command.option("--url <url>"),
  redactSensitiveUrlLikeString: (text: string) => text,
}));
// mock-isolation: Capture CLI output and exits without changing process state.
vi.mock("openclaw/plugin-sdk/runtime-env", () => ({ defaultRuntime: mocks }));

import { registerMcpRelayCli } from "./cli.js";

async function runCli(args: string[]) {
  const program = new Command().exitOverride();
  await registerMcpRelayCli({
    program,
    parentPath: [],
    config: {},
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  });
  await program.parseAsync(["mcp-relay", ...args], { from: "user" });
}

describe("MCP relay CLI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.callGatewayFromCli.mockReset().mockResolvedValue({ connected: true });
  });

  it.each([
    { args: ["status"], method: "status", params: {}, scope: "operator.read" },
    { args: ["pair"], method: "pair", params: {}, scope: "operator.admin" },
    { args: ["grants"], method: "grants", params: {}, scope: "operator.admin" },
    {
      args: ["revoke", "gr_fixture"],
      method: "revoke",
      params: { grantId: "gr_fixture" },
      scope: "operator.admin",
    },
  ])(
    "routes $method through the running Gateway with its required scope",
    async ({ args, method, params, scope }) => {
      await runCli([...args, "--json", "--url", "ws://localhost:19000"]);

      expect(mocks.callGatewayFromCli).toHaveBeenCalledWith(
        `mcp-relay.${method}`,
        expect.objectContaining({ json: true, url: "ws://localhost:19000" }),
        params,
        { progress: false, scopes: [scope] },
      );
      expect(mocks.writeJson).toHaveBeenCalledWith({ connected: true });
    },
  );

  it("prints the offered code, endpoint, expiry, and connection instructions", async () => {
    mocks.callGatewayFromCli.mockResolvedValue({
      code: "ABCDE-FGHJK",
      mcpUrl: "https://mcp.openclaw.ai/mcp",
      expiresAt: 600_000,
    });
    await runCli(["pair"]);

    const output = mocks.log.mock.calls.flat().join("\n");
    expect(output).toContain("ABCDE-FGHJK");
    expect(output).toContain("https://mcp.openclaw.ai/mcp");
    expect(output).toContain("1970-01-01T00:10:00.000Z");
    expect(output).toContain("consent page");
  });

  it("reports Gateway failures with recovery instructions and a failing exit", async () => {
    mocks.callGatewayFromCli.mockRejectedValue(new Error("Gateway offline."));
    await runCli(["pair", "--json"]);

    expect(mocks.writeJson).toHaveBeenCalledWith({
      error: expect.stringContaining("openclaw plugins enable mcp-relay"),
    });
    expect(mocks.exit).toHaveBeenCalledWith(1);
  });
});

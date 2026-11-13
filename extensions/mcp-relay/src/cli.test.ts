import { Command } from "commander";
import { AsyncWorkScope } from "openclaw/plugin-sdk/concurrency-runtime";
import { beforeEach, expect, it, vi } from "vitest";

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

beforeEach(() => {
  vi.resetAllMocks();
});

it.each([
  ["status", {}, "operator.read", true],
  ["pair", {}, "operator.admin", false],
  ["grants", {}, "operator.admin", true],
  ["revoke", { grantId: "gr_fixture" }, "operator.admin", false],
] as const)("routes %s and drops only interrupted reads", async (method, params, scope, read) => {
  const work = new AsyncWorkScope();
  mocks.callGatewayFromCli.mockImplementation(async () => {
    work.beginClose(new Error("interrupted"));
    return { connected: true };
  });
  const result = work.run(() => runCli([method, ...Object.values(params), "--json"]));
  await (read ? expect(result).rejects.toThrow("interrupted") : result);
  expect(mocks.callGatewayFromCli).toHaveBeenCalledWith(
    `mcp-relay.${method}`,
    expect.objectContaining({ json: true }),
    params,
    { progress: false, scopes: [scope], ...(read && { signal: work.signal }) },
  );
  expect(mocks.writeJson).toHaveBeenCalledTimes(read ? 0 : 1);
});

it("prints pairing details and instructions", async () => {
  mocks.callGatewayFromCli.mockResolvedValue({
    code: "ABCDE-FGHJK",
    mcpUrl: "https://mcp.openclaw.ai/mcp",
    expiresAt: 600_000,
  });
  await runCli(["pair"]);

  expect(mocks.log).toHaveBeenCalledWith("Pairing code: ABCDE-FGHJK");
  expect(mocks.log).toHaveBeenCalledWith("Expires: 1970-01-01T00:10:00.000Z");
});

it.each([
  [{ available: true, basePath: "/control" }, "Control UI: available (/control)"],
  [
    { available: false, reason: "Update the relay." },
    "Control UI: unavailable — Update the relay.",
  ],
] as const)("prints UI availability: %j", async (ui, line) => {
  mocks.callGatewayFromCli.mockResolvedValue({ connected: true, ui });
  await runCli(["status"]);
  expect(mocks.log).toHaveBeenCalledWith(line);
  mocks.log.mockClear();
  await runCli(["status", "--json"]);
  expect(mocks.log).not.toHaveBeenCalled();
});

it.each([false, true])("reports Gateway recovery instructions (json=%s)", async (json) => {
  mocks.callGatewayFromCli.mockRejectedValue(
    new Error("Gateway offline.", { cause: new Error("Private transport diagnostics.") }),
  );
  const result = runCli(["pair", ...(json ? ["--json"] : [])]);
  const message =
    "Gateway offline.\nCheck that the Gateway is running and mcp-relay is enabled with openclaw plugins enable mcp-relay, then retry.";

  if (json) {
    await expect(result).rejects.toThrow(message);
    await expect(result).rejects.not.toHaveProperty("cause");
  } else {
    await result;
    expect(mocks.error).toHaveBeenCalledExactlyOnceWith(message);
    expect(mocks.exit).toHaveBeenCalledExactlyOnceWith(1);
  }
});

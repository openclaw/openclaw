import { GatewayClientRequestError } from "@openclaw/gateway-client";
import { Command } from "commander";
import "openclaw/plugin-sdk/compiled-subprocess-testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

const gatewayMocks = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn(),
}));
const runtime = vi.hoisted(() => ({
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
  writeJson: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  defaultRuntime: runtime,
}));
vi.mock("openclaw/plugin-sdk/node-cli-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/node-cli-runtime")>()),
  runNodesCommand: (_label: string, action: () => Promise<void>) => action(),
  getNodesTheme: () => ({ ok: (value: string) => value }),
}));

vi.mock("openclaw/plugin-sdk/gateway-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/gateway-runtime")>()),
  callGatewayFromCli: gatewayMocks.callGatewayFromCli,
}));

import { registerNodesCanvasCommands } from "./cli.js";

const nodeList = { nodes: [{ nodeId: "mac-1", displayName: "Studio" }] };

function requestError(
  overrides: Partial<ConstructorParameters<typeof GatewayClientRequestError>[0]> = {},
) {
  return new GatewayClientRequestError({
    code: "INVALID_REQUEST",
    message: "unknown method: node.list",
    ...overrides,
  });
}

function runCanvas(args: string[], node = "mac-1") {
  const program = new Command();
  program.exitOverride();
  registerNodesCanvasCommands(program.command("nodes"));
  return program.parseAsync(["nodes", "canvas", ...args, "--node", node], { from: "user" });
}

function expectInvoke(
  params: unknown,
  opts: unknown = expect.any(Object),
  progress: unknown = expect.any(Object),
) {
  expect(gatewayMocks.callGatewayFromCli).toHaveBeenCalledWith(
    "node.invoke",
    opts,
    params,
    progress,
  );
}

describe("nodes canvas CLI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gatewayMocks.callGatewayFromCli
      .mockReset()
      .mockImplementation(async (method: string) =>
        method === "node.list" ? nodeList : { ok: true },
      );
  });

  it.each([
    ["present", [], {}],
    ["hide", [], undefined],
    [
      "navigate",
      ["/__openclaw__/canvas/documents/cv_1/index.html"],
      { url: "/__openclaw__/canvas/documents/cv_1/index.html" },
    ],
  ] as const)("invokes canvas.%s and prints its acknowledgement", async (action, args, params) => {
    await runCanvas([action, ...args], "Studio");

    expectInvoke(
      {
        nodeId: "mac-1",
        command: `canvas.${action}`,
        params,
        timeoutMs: 30_000,
        idempotencyKey: expect.any(String),
      },
      expect.objectContaining({ timeout: "40000" }),
      { progress: true },
    );
    expect(runtime.log).toHaveBeenCalledWith(`canvas ${action} ok`);
  });

  it("preserves present target and placement fields", async () => {
    await runCanvas([
      "present",
      "--target",
      "openclaw://widget/local",
      "--x",
      "10.5",
      "--y",
      "-2",
      "--width",
      "640",
      "--height",
      "480",
    ]);

    expectInvoke(
      expect.objectContaining({
        command: "canvas.present",
        params: {
          url: "openclaw://widget/local",
          placement: { x: 10.5, y: -2, width: 640, height: 480 },
        },
      }),
    );
  });

  it("prints the full Gateway response in JSON mode", async () => {
    const response = { ok: true, command: "canvas.hide", payload: { acknowledged: true } };
    gatewayMocks.callGatewayFromCli.mockResolvedValueOnce(nodeList).mockResolvedValueOnce(response);
    await runCanvas(["hide", "--json"]);

    expect(runtime.writeJson).toHaveBeenCalledWith(response);
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("keeps the Gateway deadline longer than an explicit node deadline", async () => {
    await runCanvas(["hide", "--invoke-timeout", "35000"]);

    expectInvoke(
      expect.objectContaining({ timeoutMs: 35_000 }),
      expect.objectContaining({ timeout: "45000" }),
      { progress: true },
    );
  });

  it.each([
    ["--width", "640px", "--width must be a number."],
    ["--invoke-timeout", "20ms", "--invoke-timeout must be a positive integer."],
  ])("rejects invalid present %s values", async (flag, value, message) => {
    await expect(runCanvas(["present", flag, value])).rejects.toThrow(message);
    expect(gatewayMocks.callGatewayFromCli).not.toHaveBeenCalled();
  });

  it("resolves and invokes a paired node when an older Gateway lacks node.list", async () => {
    gatewayMocks.callGatewayFromCli.mockRejectedValueOnce(requestError()).mockResolvedValueOnce({
      pending: [],
      paired: [{ nodeId: "legacy-node", displayName: "Legacy Node" }],
    });

    await runCanvas(["hide"], "Legacy Node");

    expect(gatewayMocks.callGatewayFromCli.mock.calls.map(([method]) => method)).toEqual([
      "node.list",
      "node.pair.list",
      "node.invoke",
    ]);
    expectInvoke(expect.objectContaining({ nodeId: "legacy-node", command: "canvas.hide" }));
  });

  it.each([
    ["an authorization rejection", requestError({ code: "FORBIDDEN" })],
    ["a retryable unknown-method rejection", requestError({ retryable: true })],
    [
      "an unknown-method rejection for another method",
      requestError({ message: "unknown method: node.list.extra" }),
    ],
    ["malformed request retry metadata", requestError({ retryAfterMs: -1 })],
    [
      "a malformed request-error lookalike",
      Object.assign(new Error("unknown method: node.list"), {
        name: "GatewayClientRequestError",
        gatewayCode: "INVALID_REQUEST",
      }),
    ],
    ["a plain unknown-method error", new Error("unknown method: node.list")],
  ] as const)("preserves %s without resolving or invoking a stale node", async (_label, error) => {
    gatewayMocks.callGatewayFromCli.mockRejectedValueOnce(error).mockResolvedValueOnce({
      pending: [],
      paired: [{ nodeId: "stale-node", displayName: "Stale Node" }],
    });

    await expect(runCanvas(["hide"], "Stale Node")).rejects.toBe(error);

    expect(gatewayMocks.callGatewayFromCli.mock.calls.map(([method]) => method)).toEqual([
      "node.list",
    ]);
    expect(runtime.log).not.toHaveBeenCalled();
  });
});

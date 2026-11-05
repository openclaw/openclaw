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
const localUrl = "openclaw://widget/local";
const placement = { x: 10.5, y: -2, width: 640, height: 480 };
const hostedUrl = "/__openclaw__/canvas/documents/cv_1/index.html";

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
    ["present", [], {}, 30_000],
    ["hide", [], undefined, 30_000],
    ["navigate", [hostedUrl], { url: hostedUrl }, 30_000],
    [
      "present",
      [
        "--target",
        localUrl,
        ...Object.entries(placement).flatMap(([key, value]) => [`--${key}`, String(value)]),
      ],
      { url: localUrl, placement },
      30_000,
    ],
    ["hide", ["--invoke-timeout", "35000"], undefined, 35_000],
  ] as const)("invokes %s with %j", async (action, args, params, timeoutMs) => {
    await runCanvas([action, ...args], "Studio");

    expect(gatewayMocks.callGatewayFromCli).toHaveBeenCalledWith(
      "node.invoke",
      expect.objectContaining({ timeout: String(timeoutMs + 10_000) }),
      {
        nodeId: "mac-1",
        command: `canvas.${action}`,
        params,
        timeoutMs,
        idempotencyKey: expect.any(String),
      },
      { progress: true },
    );
    expect(runtime.log).toHaveBeenCalledWith(`canvas ${action} ok`);
  });

  it("prints the full Gateway response in JSON mode", async () => {
    const response = { ok: true, command: "canvas.hide", payload: { acknowledged: true } };
    gatewayMocks.callGatewayFromCli.mockResolvedValueOnce(nodeList).mockResolvedValueOnce(response);
    await runCanvas(["hide", "--json"]);

    expect(runtime.writeJson).toHaveBeenCalledWith(response);
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it.each([
    ["--width", "640px", "--width must be a number."],
    ["--invoke-timeout", "20ms", "--invoke-timeout must be a positive integer."],
  ])("rejects invalid present %s values", async (flag, value, message) => {
    await expect(runCanvas(["present", flag, value])).rejects.toThrow(message);
    expect(gatewayMocks.callGatewayFromCli).not.toHaveBeenCalled();
  });

  it.each(
    Object.entries({
      unknownMethod: requestError(),
      forbidden: requestError({ code: "FORBIDDEN" }),
      retryable: requestError({ retryable: true }),
      otherMethod: requestError({ message: "unknown method: node.list.extra" }),
      invalidRetryMetadata: requestError({ retryAfterMs: -1 }),
      lookalike: Object.assign(new Error("unknown method: node.list"), {
        name: "GatewayClientRequestError",
        gatewayCode: "INVALID_REQUEST",
      }),
      plainError: new Error("unknown method: node.list"),
    }),
  )("preserves %s without resolving or invoking a stale node", async (_label, error) => {
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

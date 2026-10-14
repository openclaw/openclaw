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

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerNodesCanvasCommands(program.command("nodes"));
  return program;
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
    {
      args: ["present"],
      command: "canvas.present",
      params: {},
      message: "canvas present ok",
    },
    {
      args: ["hide"],
      command: "canvas.hide",
      params: undefined,
      message: "canvas hide ok",
    },
    {
      args: ["navigate", "/__openclaw__/canvas/documents/cv_1/index.html"],
      command: "canvas.navigate",
      params: { url: "/__openclaw__/canvas/documents/cv_1/index.html" },
      message: "canvas navigate ok",
    },
  ])(
    "invokes $command and prints its acknowledgement",
    async ({ args, command, params, message }) => {
      const program = createProgram();

      await program.parseAsync(["nodes", "canvas", ...args, "--node", "Studio"], {
        from: "user",
      });

      expect(gatewayMocks.callGatewayFromCli).toHaveBeenCalledWith(
        "node.invoke",
        expect.objectContaining({ timeout: "40000" }),
        {
          nodeId: "mac-1",
          command,
          params,
          timeoutMs: 30_000,
          idempotencyKey: expect.any(String),
        },
        { progress: true },
      );
      expect(runtime.log).toHaveBeenCalledWith(message);
    },
  );

  it("preserves present target and placement fields", async () => {
    const program = createProgram();

    await program.parseAsync(
      [
        "nodes",
        "canvas",
        "present",
        "--node",
        "mac-1",
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
      ],
      { from: "user" },
    );

    expect(gatewayMocks.callGatewayFromCli).toHaveBeenCalledWith(
      "node.invoke",
      expect.any(Object),
      expect.objectContaining({
        command: "canvas.present",
        params: {
          url: "openclaw://widget/local",
          placement: { x: 10.5, y: -2, width: 640, height: 480 },
        },
      }),
      expect.any(Object),
    );
  });

  it("prints the full Gateway response in JSON mode", async () => {
    const response = { ok: true, command: "canvas.hide", payload: { acknowledged: true } };
    gatewayMocks.callGatewayFromCli.mockResolvedValueOnce(nodeList).mockResolvedValueOnce(response);
    const program = createProgram();

    await program.parseAsync(["nodes", "canvas", "hide", "--node", "mac-1", "--json"], {
      from: "user",
    });

    expect(runtime.writeJson).toHaveBeenCalledWith(response);
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("keeps the Gateway deadline longer than an explicit node deadline", async () => {
    const program = createProgram();

    await program.parseAsync(
      ["nodes", "canvas", "hide", "--node", "mac-1", "--invoke-timeout", "35000"],
      { from: "user" },
    );

    expect(gatewayMocks.callGatewayFromCli).toHaveBeenCalledWith(
      "node.invoke",
      expect.objectContaining({ timeout: "45000" }),
      expect.objectContaining({ timeoutMs: 35_000 }),
      { progress: true },
    );
  });

  it.each([
    ["--width", "640px", "--width must be a number."],
    ["--invoke-timeout", "20ms", "--invoke-timeout must be a positive integer."],
  ])("rejects invalid present %s values", async (flag, value, message) => {
    const program = createProgram();

    await expect(
      program.parseAsync(["nodes", "canvas", "present", "--node", "mac-1", flag, value], {
        from: "user",
      }),
    ).rejects.toThrow(message);
    expect(gatewayMocks.callGatewayFromCli).not.toHaveBeenCalled();
  });

  it("resolves and invokes a paired node when an older Gateway lacks node.list", async () => {
    gatewayMocks.callGatewayFromCli
      .mockRejectedValueOnce(
        new GatewayClientRequestError({
          code: "INVALID_REQUEST",
          message: "unknown method: node.list",
        }),
      )
      .mockResolvedValueOnce({
        pending: [],
        paired: [{ nodeId: "legacy-node", displayName: "Legacy Node" }],
      });

    await createProgram().parseAsync(["nodes", "canvas", "hide", "--node", "Legacy Node"], {
      from: "user",
    });

    expect(gatewayMocks.callGatewayFromCli.mock.calls.map(([method]) => method)).toEqual([
      "node.list",
      "node.pair.list",
      "node.invoke",
    ]);
    expect(gatewayMocks.callGatewayFromCli).toHaveBeenCalledWith(
      "node.invoke",
      expect.any(Object),
      expect.objectContaining({ nodeId: "legacy-node", command: "canvas.hide" }),
      expect.any(Object),
    );
  });

  it.each([
    {
      label: "an authorization rejection",
      error: new GatewayClientRequestError({
        code: "FORBIDDEN",
        message: "unknown method: node.list",
      }),
    },
    {
      label: "a retryable unknown-method rejection",
      error: new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "unknown method: node.list",
        retryable: true,
      }),
    },
    {
      label: "an unknown-method rejection for another method",
      error: new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "unknown method: node.list.extra",
      }),
    },
    {
      label: "malformed request retry metadata",
      error: new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: "unknown method: node.list",
        retryAfterMs: -1,
      }),
    },
    {
      label: "a malformed request-error lookalike",
      error: Object.assign(new Error("unknown method: node.list"), {
        name: "GatewayClientRequestError",
        gatewayCode: "INVALID_REQUEST",
      }),
    },
    {
      label: "a plain unknown-method error",
      error: new Error("unknown method: node.list"),
    },
  ])("preserves $label without resolving or invoking a stale node", async ({ error }) => {
    gatewayMocks.callGatewayFromCli.mockRejectedValueOnce(error).mockResolvedValueOnce({
      pending: [],
      paired: [{ nodeId: "stale-node", displayName: "Stale Node" }],
    });

    await expect(
      createProgram().parseAsync(["nodes", "canvas", "hide", "--node", "Stale Node"], {
        from: "user",
      }),
    ).rejects.toBe(error);

    expect(gatewayMocks.callGatewayFromCli.mock.calls.map(([method]) => method)).toEqual([
      "node.list",
    ]);
    expect(runtime.log).not.toHaveBeenCalled();
  });
});

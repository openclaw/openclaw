import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatNodeInvokeFailureToolResult,
  invokeNodeSystemRun,
} from "./bash-tools.exec-host-node-failure.js";
import {
  dispatchNodeSystemRun,
  resolveNodeExecutionTarget,
} from "./bash-tools.exec-host-node-phases.js";

const callGatewayToolMock = vi.hoisted(() => vi.fn());

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: callGatewayToolMock,
}));

function gatewayNodeInvokeError(params: {
  code?: string;
  message?: string;
  nodeCommandDispatched?: boolean;
  requestSent?: boolean;
}): Error {
  return Object.assign(new Error(params.message ?? "node invoke failed"), {
    name: "GatewayClientRequestError",
    gatewayCode: "UNAVAILABLE",
    details: {
      nodeError: {
        ...(params.code ? { code: params.code } : {}),
        message: params.message ?? "node invoke failed",
      },
      ...(params.nodeCommandDispatched !== undefined
        ? { nodeCommandDispatched: params.nodeCommandDispatched }
        : {}),
    },
    ...(params.requestSent !== undefined ? { requestSent: params.requestSent } : {}),
  });
}

async function invokeFailure(error: unknown) {
  callGatewayToolMock.mockRejectedValueOnce(error);
  const result = await invokeNodeSystemRun({
    invokeWaitMs: 1_000,
    invoke: { nodeId: "node-1", command: "system.run" },
  });
  if (result.ok) {
    throw new Error("expected node invoke failure");
  }
  return result.failure;
}

describe("invokeNodeSystemRun failure classification", () => {
  it("returns a permission card without labeling rejected execution as an unknown outcome", async () => {
    const permissionMissing = {
      nodeId: "mac-node",
      command: "system.run",
      capabilities: ["screenRecording"],
      state: "denied",
    };
    const message =
      "PERMISSION_MISSING: Screen Recording required on node mac-node. The user has been shown a Grant card in the chat. Do not retry until the user confirms that access has been granted.";
    const error = Object.assign(new Error(message), {
      details: { nodeError: { code: "PERMISSION_MISSING" }, permissionMissing },
    });
    const failure = await invokeFailure(error);
    const result = formatNodeInvokeFailureToolResult({
      failure,
      nodeId: "mac-node",
      command: "screencapture",
      startedAt: 0,
      cwd: undefined,
    });
    expect(result.details).toMatchObject({ reason: "permission-missing", permissionMissing });
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining(message) }]);
    expect(result.content).not.toEqual([
      { type: "text", text: expect.stringContaining("may have executed") },
    ]);
  });
  it("classifies only proven pre-dispatch NOT_CONNECTED as retry-safe", async () => {
    await expect(
      invokeFailure(
        gatewayNodeInvokeError({
          code: "NOT_CONNECTED",
          message: "node not connected",
          nodeCommandDispatched: false,
          requestSent: true,
        }),
      ),
    ).resolves.toEqual({
      reason: "not-dispatched",
      retrySafe: true,
      code: "NOT_CONNECTED",
      message: "node not connected",
      nodeCommandDispatched: false,
      requestSent: true,
    });
  });

  it.each([
    {
      name: "missing dispatch provenance",
      error: gatewayNodeInvokeError({ code: "NOT_CONNECTED" }),
    },
    {
      name: "client timeout before request bytes crossed send",
      error: Object.assign(new Error("gateway request timeout for node.invoke"), {
        name: "GatewayClientRequestTimeoutError",
        requestSent: false,
      }),
    },
    {
      name: "malformed failure",
      error: { message: 42 },
    },
  ])("classifies $name as outcome-unknown", async ({ error }) => {
    await expect(invokeFailure(error)).resolves.toMatchObject({
      reason: "outcome-unknown",
      retrySafe: false,
    });
  });
});

describe("node execution target resolution", () => {
  beforeEach(() => {
    callGatewayToolMock.mockReset();
  });

  it("retains the shipped marker transport for nodes without execution-context support", async () => {
    callGatewayToolMock.mockResolvedValueOnce({
      nodes: [
        {
          nodeId: "legacy-windows",
          platform: "win32",
          connected: true,
          commands: ["system.run", "system.run.prepare"],
          caps: ["system"],
        },
      ],
    });
    const target = await resolveNodeExecutionTarget({
      ...createDirectNodeRun().request,
      requestedEnv: { CUSTOM: "unchanged" },
      executionContext: { senderId: "sender-1", subagent: true },
    });
    expect(target.executionContext).toBeUndefined();
    expect(target.argv).toEqual(["cmd.exe", "/d", "/s", "/c", "tool --version"]);
    expect(target.env).toEqual({
      CUSTOM: "unchanged",
      OPENCLAW_CHANNEL_CONTEXT: '{"sender":{"id":"sender-1"}}',
      OPENCLAW_SUBAGENT_EXEC: "1",
    });
  });

  it("rejects inventory records without execution capabilities", async () => {
    callGatewayToolMock.mockResolvedValueOnce({
      nodes: [{ nodeId: "node-1", platform: "linux" }],
    });

    await expect(resolveNodeExecutionTarget(createDirectNodeRun().request)).rejects.toThrow(
      /supports system.run/,
    );
    expect(callGatewayToolMock.mock.calls.map(([method]) => method)).toEqual(["node.list"]);
  });

  it("requires an explicit target when multiple connected nodes support system.run", async () => {
    callGatewayToolMock.mockResolvedValueOnce({
      nodes: [
        {
          nodeId: "mac-a",
          displayName: "Desk Mac",
          platform: "macos",
          caps: ["canvas"],
          commands: ["system.run"],
          connected: true,
          connectedAtMs: 1_000,
          active: true,
        },
        {
          nodeId: "mac-b",
          displayName: "Travel Mac",
          platform: "macos",
          caps: ["canvas"],
          commands: ["system.run"],
          connected: true,
          connectedAtMs: 2_000,
        },
      ],
    });

    await expect(resolveNodeExecutionTarget(createDirectNodeRun().request)).rejects.toThrow(
      /multiple.*mac-a.*mac-b/i,
    );
    expect(callGatewayToolMock).toHaveBeenCalledTimes(1);
    expect(callGatewayToolMock).toHaveBeenCalledWith(
      "node.list",
      {},
      {},
      expect.objectContaining({ signal: undefined }),
    );
  });

  it("honors an explicit executable node among multiple candidates", async () => {
    callGatewayToolMock.mockResolvedValueOnce({
      nodes: [
        { nodeId: "node-a", commands: ["system.run"], connected: true },
        { nodeId: "node-b", commands: ["system.run"], connected: true },
      ],
    });

    await expect(
      resolveNodeExecutionTarget({ ...createDirectNodeRun().request, requestedNode: "node-a" }),
    ).resolves.toMatchObject({ nodeId: "node-a" });
  });

  it.each(["build-worker"])(
    "rejects an ambiguous configured binding %s before filtering executable nodes",
    async (boundNode) => {
      callGatewayToolMock.mockResolvedValueOnce({
        nodes: [
          {
            nodeId: "node-shared-exec",
            displayName: "build-worker",
            clientId: "openclaw-macos",
            commands: ["system.run"],
            connected: true,
          },
          {
            nodeId: "node-shared-canvas",
            displayName: "build-worker",
            clientId: "node-host",
            commands: ["canvas.present"],
            connected: true,
          },
        ],
      });

      await expect(
        resolveNodeExecutionTarget({ ...createDirectNodeRun().request, boundNode }),
      ).rejects.toThrow(/ambiguous node/);
      expect(callGatewayToolMock).toHaveBeenCalledTimes(1);
    },
  );
});

type DirectNodeRun = Parameters<typeof dispatchNodeSystemRun>[0];

function createDirectNodeRun(signal?: AbortSignal): DirectNodeRun {
  return {
    invoke: {
      nodeId: "node-1",
      command: "system.run",
      params: { command: ["tool", "--version"], rawCommand: "tool --version" },
    },
    request: {
      command: "tool --version",
      workdir: "/tmp/work",
      env: {},
      security: "full",
      ask: "off",
      defaultTimeoutSec: 30,
      approvalRunningNoticeMs: 0,
      warnings: [],
      ...(signal ? { signal } : {}),
    },
    target: {
      nodeId: "node-1",
      argv: ["tool", "--version"],
      env: undefined,
      invokeDeadlineMs: 30_000,
      invokeWaitMs: 35_000,
      runTimeoutMs: 30_000,
      supportsSystemRunPrepare: true,
    },
  };
}

describe("direct node run", () => {
  beforeEach(() => {
    callGatewayToolMock.mockReset();
    callGatewayToolMock.mockResolvedValue({
      payload: { success: true, stdout: "ok", stderr: "", exitCode: 0 },
    });
  });

  it.each(["timeout", "malformed response"])("keeps %s outcomes ambiguous", async (kind) => {
    if (kind === "timeout") {
      callGatewayToolMock.mockRejectedValueOnce(
        gatewayNodeInvokeError({
          code: "TIMEOUT",
          nodeCommandDispatched: true,
        }),
      );
    } else {
      callGatewayToolMock.mockResolvedValueOnce({ payload: { stdout: "partial" } });
    }
    const result = await dispatchNodeSystemRun(createDirectNodeRun());
    expect(result.details).toMatchObject({ status: "failed", reason: "outcome-unknown" });
    expect(result.content).toEqual([
      expect.objectContaining({
        text: expect.stringContaining(
          "The command may have executed. Do not rerun it automatically.",
        ),
      }),
    ]);
  });

  it("forwards the original cancellation signal to the gateway", async () => {
    const controller = new AbortController();
    await dispatchNodeSystemRun(createDirectNodeRun(controller.signal));

    expect(callGatewayToolMock).toHaveBeenCalledWith(
      "node.invoke",
      { timeoutMs: 35_000 },
      expect.objectContaining({ command: "system.run" }),
      { signal: controller.signal },
    );
  });

  it("combines stdout, stderr, and the node error", async () => {
    const stdout = "small stdout";
    const stderr = "node stderr";
    const errorText = "node command failed";
    callGatewayToolMock.mockResolvedValueOnce({
      payload: {
        success: false,
        stdout,
        stderr,
        error: errorText,
        exitCode: 1,
      },
    });

    const result = await dispatchNodeSystemRun(createDirectNodeRun());
    const visibleText = result.content[0]?.type === "text" ? result.content[0].text : "";

    const output = `${stdout}\n${stderr}\n${errorText}\n(Command exited with code 1)`;
    expect(visibleText).toBe(`Node: node-1\n${output}`);
    expect(result.details).toMatchObject({
      status: "failed",
      exitCode: 1,
      aggregated: output,
      nodeId: "node-1",
    });
  });

  it("renders a timeout marker and records timedOut in details", async () => {
    callGatewayToolMock.mockResolvedValueOnce({
      payload: { success: false, stdout: "", stderr: "", error: null, timedOut: true },
    });

    const result = await dispatchNodeSystemRun(createDirectNodeRun());
    const visibleText = result.content[0]?.type === "text" ? result.content[0].text : "";

    expect(visibleText).toContain("Command timed out.");
    expect(visibleText).toContain("Node: node-1");
    expect(result.details).toMatchObject({ status: "failed", timedOut: true });
  });

  it("never dispatches a direct node run after cancellation", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled before direct node dispatch");
    controller.abort(reason);

    await expect(dispatchNodeSystemRun(createDirectNodeRun(controller.signal))).rejects.toBe(
      reason,
    );
    expect(callGatewayToolMock).not.toHaveBeenCalled();
  });
});

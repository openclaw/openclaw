import { beforeEach, describe, expect, it, vi } from "vitest";

const { callGateway } = vi.hoisted(() => ({
  callGateway: vi.fn(),
}));

vi.mock("../gateway/call.js", () => ({ callGateway }));
vi.mock("../media/image-ops.js", () => ({
  getImageMetadata: vi.fn(async () => ({ width: 1, height: 1 })),
  resizeToJpeg: vi.fn(async () => Buffer.from("jpeg")),
}));

import "./test-helpers/fast-core-tools.js";
import { createOpenClawTools } from "./openclaw-tools.js";

const NODE_ID = "mac-1";
const BASE_RUN_INPUT = { action: "run", node: NODE_ID, command: ["echo", "hi"] } as const;
const JPG_PAYLOAD = {
  format: "jpg",
  base64: "aGVsbG8=",
  width: 1,
  height: 1,
} as const;

type GatewayCall = { method: string; params?: unknown };

function unexpectedGatewayMethod(method: unknown): never {
  throw new Error(`unexpected method: ${String(method)}`);
}

function getNodesTool() {
  const tool = createOpenClawTools().find((candidate) => candidate.name === "nodes");
  if (!tool) {
    throw new Error("missing nodes tool");
  }
  return tool;
}

async function executeNodes(input: Record<string, unknown>) {
  return getNodesTool().execute("call1", input as never);
}

type NodesToolResult = Awaited<ReturnType<typeof executeNodes>>;
type GatewayMockResult = Record<string, unknown> | null | undefined;

function mockNodeList(commands?: string[]) {
  return {
    nodes: [{ nodeId: NODE_ID, ...(commands ? { commands } : {}) }],
  };
}

function expectSingleImage(result: NodesToolResult, params?: { mimeType?: string }) {
  const images = (result.content ?? []).filter((block) => block.type === "image");
  expect(images).toHaveLength(1);
  if (params?.mimeType) {
    expect(images[0]?.mimeType).toBe(params.mimeType);
  }
}

function expectFirstTextContains(result: NodesToolResult, expectedText: string) {
  expect(result.content?.[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining(expectedText),
  });
}

function setupNodeInvokeMock(params: {
  commands?: string[];
  onInvoke?: (invokeParams: unknown) => GatewayMockResult | Promise<GatewayMockResult>;
  invokePayload?: unknown;
}) {
  callGateway.mockImplementation(async ({ method, params: invokeParams }: GatewayCall) => {
    if (method === "node.list") {
      return mockNodeList(params.commands);
    }
    if (method === "node.invoke") {
      if (params.onInvoke) {
        return await params.onInvoke(invokeParams);
      }
      if (params.invokePayload !== undefined) {
        return { payload: params.invokePayload };
      }
      return { payload: {} };
    }
    return unexpectedGatewayMethod(method);
  });
}

function createSystemRunPreparePayload(cwd: string | null) {
  return {
    payload: {
      cmdText: "echo hi",
      plan: {
        argv: ["echo", "hi"],
        cwd,
        rawCommand: "echo hi",
        agentId: null,
        sessionKey: null,
      },
    },
  };
}

function setupSystemRunGateway(params: {
  onRunInvoke: (invokeParams: unknown) => GatewayMockResult | Promise<GatewayMockResult>;
  onApprovalRequest?: (approvalParams: unknown) => GatewayMockResult | Promise<GatewayMockResult>;
  prepareCwd?: string | null;
}) {
  callGateway.mockImplementation(async ({ method, params: gatewayParams }: GatewayCall) => {
    if (method === "node.list") {
      return mockNodeList(["system.run"]);
    }
    if (method === "node.invoke") {
      const command = (gatewayParams as { command?: string } | undefined)?.command;
      if (command === "system.run.prepare") {
        return createSystemRunPreparePayload(params.prepareCwd ?? null);
      }
      return await params.onRunInvoke(gatewayParams);
    }
    if (method === "exec.approval.request" && params.onApprovalRequest) {
      return await params.onApprovalRequest(gatewayParams);
    }
    return unexpectedGatewayMethod(method);
  });
}

beforeEach(() => {
  callGateway.mockClear();
});

describe("nodes camera_snap", () => {
  it("uses front/high-quality defaults when params are omitted", async () => {
    setupNodeInvokeMock({
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          command: "camera.snap",
          params: {
            facing: "front",
            maxWidth: 1600,
            quality: 0.95,
          },
        });
        return { payload: JPG_PAYLOAD };
      },
    });

    const result = await executeNodes({
      action: "camera_snap",
      node: NODE_ID,
    });

    expectSingleImage(result);
  });

  it("maps jpg payloads to image/jpeg", async () => {
    setupNodeInvokeMock({
      invokePayload: JPG_PAYLOAD,
    });

    const result = await executeNodes({
      action: "camera_snap",
      node: NODE_ID,
      facing: "front",
    });

    expectSingleImage(result, { mimeType: "image/jpeg" });
  });

  it("passes deviceId when provided", async () => {
    setupNodeInvokeMock({
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          command: "camera.snap",
          params: { deviceId: "cam-123" },
        });
        return { payload: JPG_PAYLOAD };
      },
    });

    await executeNodes({
      action: "camera_snap",
      node: NODE_ID,
      facing: "front",
      deviceId: "cam-123",
    });
  });

  it("rejects facing both when deviceId is provided", async () => {
    await expect(
      executeNodes({
        action: "camera_snap",
        node: NODE_ID,
        facing: "both",
        deviceId: "cam-123",
      }),
    ).rejects.toThrow(/facing=both is not allowed when deviceId is set/i);
  });
});

describe("nodes notifications_list", () => {
  it("invokes notifications.list and returns payload", async () => {
    setupNodeInvokeMock({
      commands: ["notifications.list"],
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          nodeId: NODE_ID,
          command: "notifications.list",
          params: {},
        });
        return {
          payload: {
            enabled: true,
            connected: true,
            count: 1,
            notifications: [{ key: "n1", packageName: "com.example.app" }],
          },
        };
      },
    });

    const result = await executeNodes({
      action: "notifications_list",
      node: NODE_ID,
    });

    expectFirstTextContains(result, '"notifications"');
  });
});

describe("nodes notifications_action", () => {
  it("invokes notifications.actions dismiss", async () => {
    setupNodeInvokeMock({
      commands: ["notifications.actions"],
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          nodeId: NODE_ID,
          command: "notifications.actions",
          params: {
            key: "n1",
            action: "dismiss",
          },
        });
        return { payload: { ok: true, key: "n1", action: "dismiss" } };
      },
    });

    const result = await executeNodes({
      action: "notifications_action",
      node: NODE_ID,
      notificationKey: "n1",
      notificationAction: "dismiss",
    });

    expectFirstTextContains(result, '"dismiss"');
  });
});

describe("nodes device_status and device_info", () => {
  it("invokes device.status and returns payload", async () => {
    setupNodeInvokeMock({
      commands: ["device.status", "device.info"],
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          nodeId: NODE_ID,
          command: "device.status",
          params: {},
        });
        return {
          payload: {
            battery: { state: "charging", lowPowerModeEnabled: false },
          },
        };
      },
    });

    const result = await executeNodes({
      action: "device_status",
      node: NODE_ID,
    });

    expectFirstTextContains(result, '"battery"');
  });

  it("invokes device.info and returns payload", async () => {
    setupNodeInvokeMock({
      commands: ["device.status", "device.info"],
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          nodeId: NODE_ID,
          command: "device.info",
          params: {},
        });
        return {
          payload: {
            systemName: "Android",
            appVersion: "1.0.0",
          },
        };
      },
    });

    const result = await executeNodes({
      action: "device_info",
      node: NODE_ID,
    });

    expectFirstTextContains(result, '"systemName"');
  });

  it("invokes device.permissions and returns payload", async () => {
    setupNodeInvokeMock({
      commands: ["device.permissions"],
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          nodeId: NODE_ID,
          command: "device.permissions",
          params: {},
        });
        return {
          payload: {
            permissions: {
              camera: { status: "granted", promptable: false },
            },
          },
        };
      },
    });

    const result = await executeNodes({
      action: "device_permissions",
      node: NODE_ID,
    });

    expectFirstTextContains(result, '"permissions"');
  });

  it("invokes device.health and returns payload", async () => {
    setupNodeInvokeMock({
      commands: ["device.health"],
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          nodeId: NODE_ID,
          command: "device.health",
          params: {},
        });
        return {
          payload: {
            memory: { pressure: "normal" },
            battery: { chargingType: "usb" },
          },
        };
      },
    });

    const result = await executeNodes({
      action: "device_health",
      node: NODE_ID,
    });

    expectFirstTextContains(result, '"memory"');
  });
});

describe("nodes run", () => {
  it("passes invoke and command timeouts", async () => {
    setupSystemRunGateway({
      prepareCwd: "/tmp",
      onRunInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          nodeId: NODE_ID,
          command: "system.run",
          timeoutMs: 45_000,
          params: {
            command: ["echo", "hi"],
            cwd: "/tmp",
            env: { FOO: "bar" },
            timeoutMs: 12_000,
          },
        });
        return {
          payload: { stdout: "", stderr: "", exitCode: 0, success: true },
        };
      },
    });

    await executeNodes({
      ...BASE_RUN_INPUT,
      cwd: "/tmp",
      env: ["FOO=bar"],
      commandTimeoutMs: 12_000,
      invokeTimeoutMs: 45_000,
    });
  });

  it("requests approval and retries with allow-once decision", async () => {
    let invokeCalls = 0;
    let approvalId: string | null = null;
    setupSystemRunGateway({
      onRunInvoke: (invokeParams) => {
        invokeCalls += 1;
        if (invokeCalls === 1) {
          throw new Error("SYSTEM_RUN_DENIED: approval required");
        }
        expect(invokeParams).toMatchObject({
          nodeId: NODE_ID,
          command: "system.run",
          params: {
            command: ["echo", "hi"],
            runId: approvalId,
            approved: true,
            approvalDecision: "allow-once",
          },
        });
        return { payload: { stdout: "", stderr: "", exitCode: 0, success: true } };
      },
      onApprovalRequest: (approvalParams) => {
        expect(approvalParams).toMatchObject({
          id: expect.any(String),
          command: "echo hi",
          commandArgv: ["echo", "hi"],
          systemRunPlan: expect.objectContaining({
            argv: ["echo", "hi"],
          }),
          nodeId: NODE_ID,
          host: "node",
          timeoutMs: 120_000,
        });
        approvalId =
          typeof (approvalParams as { id?: unknown } | undefined)?.id === "string"
            ? ((approvalParams as { id: string }).id ?? null)
            : null;
        return { decision: "allow-once" };
      },
    });

    await executeNodes(BASE_RUN_INPUT);
    expect(invokeCalls).toBe(2);
  });

  it("fails with user denied when approval decision is deny", async () => {
    setupSystemRunGateway({
      onRunInvoke: () => {
        throw new Error("SYSTEM_RUN_DENIED: approval required");
      },
      onApprovalRequest: () => {
        return { decision: "deny" };
      },
    });

    await expect(executeNodes(BASE_RUN_INPUT)).rejects.toThrow("exec denied: user denied");
  });

  it("fails closed for timeout and invalid approval decisions", async () => {
    setupSystemRunGateway({
      onRunInvoke: () => {
        throw new Error("SYSTEM_RUN_DENIED: approval required");
      },
      onApprovalRequest: () => {
        return {};
      },
    });
    await expect(executeNodes(BASE_RUN_INPUT)).rejects.toThrow("exec denied: approval timed out");

    setupSystemRunGateway({
      onRunInvoke: () => {
        throw new Error("SYSTEM_RUN_DENIED: approval required");
      },
      onApprovalRequest: () => {
        return { decision: "allow-never" };
      },
    });
    await expect(executeNodes(BASE_RUN_INPUT)).rejects.toThrow(
      "exec denied: invalid approval decision",
    );
  });
});

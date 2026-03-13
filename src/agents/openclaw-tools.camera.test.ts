import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readFileUtf8AndCleanup,
  stubFetchTextResponse,
} from "../test-utils/camera-url-test-helpers.js";

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
const PHOTOS_LATEST_ACTION_INPUT = { action: "photos_latest", node: NODE_ID } as const;
const PHOTOS_LATEST_DEFAULT_PARAMS = {
  limit: 1,
  maxWidth: 1600,
  quality: 0.85,
} as const;
const PHOTOS_LATEST_PAYLOAD = {
  photos: [
    {
      format: "jpeg",
      base64: "aGVsbG8=",
      width: 1,
      height: 1,
      createdAt: "2026-03-04T00:00:00Z",
    },
  ],
} as const;

type GatewayCall = { method: string; params?: unknown };

function unexpectedGatewayMethod(method: unknown): never {
  throw new Error(`unexpected method: ${String(method)}`);
}

function getNodesTool(options?: { modelHasVision?: boolean; allowMediaInvokeCommands?: boolean }) {
  const toolOptions: {
    modelHasVision?: boolean;
    allowMediaInvokeCommands?: boolean;
  } = {};
  if (options?.modelHasVision !== undefined) {
    toolOptions.modelHasVision = options.modelHasVision;
  }
  if (options?.allowMediaInvokeCommands !== undefined) {
    toolOptions.allowMediaInvokeCommands = options.allowMediaInvokeCommands;
  }
  const tool = createOpenClawTools(toolOptions).find((candidate) => candidate.name === "nodes");
  if (!tool) {
    throw new Error("missing nodes tool");
  }
  return tool;
}

async function executeNodes(
  input: Record<string, unknown>,
  options?: { modelHasVision?: boolean; allowMediaInvokeCommands?: boolean },
) {
  return getNodesTool(options).execute("call1", input as never);
}

type NodesToolResult = Awaited<ReturnType<typeof executeNodes>>;
type GatewayMockResult = Record<string, unknown> | null | undefined;

function mockNodeList(params?: { commands?: string[]; remoteIp?: string }) {
  return {
    nodes: [
      {
        nodeId: NODE_ID,
        ...(params?.commands ? { commands: params.commands } : {}),
        ...(params?.remoteIp ? { remoteIp: params.remoteIp } : {}),
      },
    ],
  };
}

function expectSingleImage(result: NodesToolResult, params?: { mimeType?: string }) {
  const images = (result.content ?? []).filter((block) => block.type === "image");
  expect(images).toHaveLength(1);
  if (params?.mimeType) {
    expect(images[0]?.mimeType).toBe(params.mimeType);
  }
}

function expectNoImages(result: NodesToolResult) {
  const images = (result.content ?? []).filter((block) => block.type === "image");
  expect(images).toHaveLength(0);
}

function expectFirstTextContains(result: NodesToolResult, expectedText: string) {
  expect(result.content?.[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining(expectedText),
  });
}

function setupNodeInvokeMock(params: {
  commands?: string[];
  remoteIp?: string;
  onInvoke?: (invokeParams: unknown) => GatewayMockResult | Promise<GatewayMockResult>;
  invokePayload?: unknown;
}) {
  callGateway.mockImplementation(async ({ method, params: invokeParams }: GatewayCall) => {
    if (method === "node.list") {
      return mockNodeList({ commands: params.commands, remoteIp: params.remoteIp });
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
      plan: {
        argv: ["echo", "hi"],
        cwd,
        commandText: "echo hi",
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
      return mockNodeList({ commands: ["system.run"] });
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

function setupPhotosLatestMock(params?: { remoteIp?: string }) {
  setupNodeInvokeMock({
    ...(params?.remoteIp ? { remoteIp: params.remoteIp } : {}),
    onInvoke: (invokeParams) => {
      expect(invokeParams).toMatchObject({
        command: "photos.latest",
        params: PHOTOS_LATEST_DEFAULT_PARAMS,
      });
      return { payload: PHOTOS_LATEST_PAYLOAD };
    },
  });
}

async function executePhotosLatest(params: { modelHasVision: boolean }) {
  return executeNodes(PHOTOS_LATEST_ACTION_INPUT, {
    modelHasVision: params.modelHasVision,
  });
}

beforeEach(() => {
  callGateway.mockClear();
  vi.unstubAllGlobals();
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

    const result = await executeNodes(
      {
        action: "camera_snap",
        node: NODE_ID,
      },
      { modelHasVision: true },
    );

    expectSingleImage(result);
  });

  it("maps jpg payloads to image/jpeg", async () => {
    setupNodeInvokeMock({
      invokePayload: JPG_PAYLOAD,
    });

    const result = await executeNodes(
      {
        action: "camera_snap",
        node: NODE_ID,
        facing: "front",
      },
      { modelHasVision: true },
    );

    expectSingleImage(result, { mimeType: "image/jpeg" });
  });

  it("omits inline base64 image blocks when model has no vision", async () => {
    setupNodeInvokeMock({
      invokePayload: JPG_PAYLOAD,
    });

    const result = await executeNodes(
      {
        action: "camera_snap",
        node: NODE_ID,
        facing: "front",
      },
      { modelHasVision: false },
    );

    expectNoImages(result);
    expect(result.content?.[0]).toMatchObject({
      type: "text",
      text: expect.stringMatching(/^MEDIA:/),
    });
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

  it("downloads camera_snap url payloads when node remoteIp is available", async () => {
    stubFetchTextResponse("url-image");
    setupNodeInvokeMock({
      remoteIp: "198.51.100.42",
      invokePayload: {
        format: "jpg",
        url: "https://198.51.100.42/snap.jpg",
        width: 1,
        height: 1,
      },
    });

    const result = await executeNodes({
      action: "camera_snap",
      node: NODE_ID,
      facing: "front",
    });

    expect(result.content?.[0]).toMatchObject({ type: "text" });
    const mediaPath = String((result.content?.[0] as { text?: string } | undefined)?.text ?? "")
      .replace(/^MEDIA:/, "")
      .trim();
    await expect(readFileUtf8AndCleanup(mediaPath)).resolves.toBe("url-image");
  });

  it("rejects camera_snap url payloads when node remoteIp is missing", async () => {
    stubFetchTextResponse("url-image");
    setupNodeInvokeMock({
      invokePayload: {
        format: "jpg",
        url: "https://198.51.100.42/snap.jpg",
        width: 1,
        height: 1,
      },
    });

    await expect(
      executeNodes({
        action: "camera_snap",
        node: NODE_ID,
        facing: "front",
      }),
    ).rejects.toThrow(/node remoteip/i);
  });
});

describe("nodes camera_clip", () => {
  it("downloads camera_clip url payloads when node remoteIp is available", async () => {
    stubFetchTextResponse("url-clip");
    setupNodeInvokeMock({
      remoteIp: "198.51.100.42",
      invokePayload: {
        format: "mp4",
        url: "https://198.51.100.42/clip.mp4",
        durationMs: 1200,
        hasAudio: false,
      },
    });

    const result = await executeNodes({
      action: "camera_clip",
      node: NODE_ID,
      facing: "front",
    });
    const filePath = String((result.content?.[0] as { text?: string } | undefined)?.text ?? "")
      .replace(/^FILE:/, "")
      .trim();
    await expect(readFileUtf8AndCleanup(filePath)).resolves.toBe("url-clip");
  });

  it("rejects camera_clip url payloads when node remoteIp is missing", async () => {
    stubFetchTextResponse("url-clip");
    setupNodeInvokeMock({
      invokePayload: {
        format: "mp4",
        url: "https://198.51.100.42/clip.mp4",
        durationMs: 1200,
        hasAudio: false,
      },
    });

    await expect(
      executeNodes({
        action: "camera_clip",
        node: NODE_ID,
        facing: "front",
      }),
    ).rejects.toThrow(/node remoteip/i);
  });
});

describe("nodes photos_latest", () => {
  it("returns empty content/details when no photos are available", async () => {
    setupNodeInvokeMock({
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          command: "photos.latest",
          params: {
            limit: 1,
            maxWidth: 1600,
            quality: 0.85,
          },
        });
        return {
          payload: {
            photos: [],
          },
        };
      },
    });

    const result = await executeNodes(
      {
        action: "photos_latest",
        node: NODE_ID,
      },
      { modelHasVision: false },
    );

    expect(result.content ?? []).toEqual([]);
    expect(result.details).toEqual([]);
  });

  it("returns MEDIA paths and no inline images when model has no vision", async () => {
    setupPhotosLatestMock({ remoteIp: "198.51.100.42" });

    const result = await executePhotosLatest({ modelHasVision: false });

    expectNoImages(result);
    expect(result.content?.[0]).toMatchObject({
      type: "text",
      text: expect.stringMatching(/^MEDIA:/),
    });
    const details = Array.isArray(result.details) ? result.details : [];
    expect(details[0]).toMatchObject({
      width: 1,
      height: 1,
      createdAt: "2026-03-04T00:00:00Z",
    });
  });

  it("includes inline image blocks when model has vision", async () => {
    setupPhotosLatestMock();

    const result = await executePhotosLatest({ modelHasVision: true });

    expect(result.content?.[0]).toMatchObject({
      type: "text",
      text: expect.stringMatching(/^MEDIA:/),
    });
    expectSingleImage(result, { mimeType: "image/jpeg" });
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
          systemRunPlan: expect.objectContaining({
            argv: ["echo", "hi"],
            commandText: "echo hi",
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

describe("nodes invoke", () => {
  it("allows metadata-only camera.list via generic invoke", async () => {
    setupNodeInvokeMock({
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          command: "camera.list",
          params: {},
        });
        return {
          payload: {
            devices: [{ id: "cam-back", name: "Back Camera" }],
          },
        };
      },
    });

    const result = await executeNodes({
      action: "invoke",
      node: NODE_ID,
      invokeCommand: "camera.list",
    });

    expect(result.details).toMatchObject({
      payload: {
        devices: [{ id: "cam-back", name: "Back Camera" }],
      },
    });
  });

  it("blocks media invoke commands to avoid base64 context bloat", async () => {
    await expect(
      executeNodes({
        action: "invoke",
        node: NODE_ID,
        invokeCommand: "photos.latest",
        invokeParamsJson: '{"limit":1}',
      }),
    ).rejects.toThrow(/use action="photos_latest"/i);
  });

  it("allows media invoke commands when explicitly enabled", async () => {
    setupNodeInvokeMock({
      onInvoke: (invokeParams) => {
        expect(invokeParams).toMatchObject({
          command: "photos.latest",
          params: { limit: 1 },
        });
        return {
          payload: {
            photos: [{ format: "jpg", base64: "aGVsbG8=", width: 1, height: 1 }],
          },
        };
      },
    });

    const result = await executeNodes(
      {
        action: "invoke",
        node: NODE_ID,
        invokeCommand: "photos.latest",
        invokeParamsJson: '{"limit":1}',
      },
      { allowMediaInvokeCommands: true },
    );

    expect(result.details).toMatchObject({
      payload: {
        photos: [{ format: "jpg", base64: "aGVsbG8=", width: 1, height: 1 }],
      },
    });
  });
});

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

describe("nodes camera_snap", () => {
  beforeEach(() => {
    callGateway.mockReset();
  });

  it("maps jpg payloads to image/jpeg", async () => {
    callGateway.mockImplementation(async ({ method }) => {
      if (method === "node.list") {
        return { nodes: [{ nodeId: "mac-1" }] };
      }
      if (method === "node.invoke") {
        return {
          payload: {
            format: "jpg",
            base64: "aGVsbG8=",
            width: 1,
            height: 1,
          },
        };
      }
      throw new Error(`unexpected method: ${String(method)}`);
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "nodes");
    if (!tool) {
      throw new Error("missing nodes tool");
    }

    const result = await tool.execute("call1", {
      action: "camera_snap",
      node: "mac-1",
      facing: "front",
    });

    const images = (result.content ?? []).filter((block) => block.type === "image");
    expect(images).toHaveLength(1);
    expect(images[0]?.mimeType).toBe("image/jpeg");
  });

  it("passes deviceId when provided", async () => {
    callGateway.mockImplementation(async ({ method, params }) => {
      if (method === "node.list") {
        return { nodes: [{ nodeId: "mac-1" }] };
      }
      if (method === "node.invoke") {
        expect(params).toMatchObject({
          command: "camera.snap",
          params: { deviceId: "cam-123" },
        });
        return {
          payload: {
            format: "jpg",
            base64: "aGVsbG8=",
            width: 1,
            height: 1,
          },
        };
      }
      throw new Error(`unexpected method: ${String(method)}`);
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "nodes");
    if (!tool) {
      throw new Error("missing nodes tool");
    }

    await tool.execute("call1", {
      action: "camera_snap",
      node: "mac-1",
      facing: "front",
      deviceId: "cam-123",
    });
  });
});

describe("nodes run", () => {
  beforeEach(() => {
    callGateway.mockReset();
  });

  it("passes invoke and command timeouts", async () => {
    callGateway.mockImplementation(async ({ method, params }) => {
      if (method === "node.list") {
        return { nodes: [{ nodeId: "mac-1", commands: ["system.run"] }] };
      }
      if (method === "node.invoke") {
        expect(params).toMatchObject({
          nodeId: "mac-1",
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
      }
      throw new Error(`unexpected method: ${String(method)}`);
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "nodes");
    if (!tool) {
      throw new Error("missing nodes tool");
    }

    await tool.execute("call1", {
      action: "run",
      node: "mac-1",
      command: ["echo", "hi"],
      cwd: "/tmp",
      env: ["FOO=bar"],
      commandTimeoutMs: 12_000,
      invokeTimeoutMs: 45_000,
    });
  });

  it("requests approval and retries with allow-once decision", async () => {
    let invokeCalls = 0;
    let approvalId: string | null = null;
    callGateway.mockImplementation(async ({ method, params }) => {
      if (method === "node.list") {
        return { nodes: [{ nodeId: "mac-1", commands: ["system.run"] }] };
      }
      if (method === "node.invoke") {
        invokeCalls += 1;
        if (invokeCalls === 1) {
          throw new Error("SYSTEM_RUN_DENIED: approval required");
        }
        expect(params).toMatchObject({
          nodeId: "mac-1",
          command: "system.run",
          params: {
            command: ["echo", "hi"],
            runId: approvalId,
            approved: true,
            approvalDecision: "allow-once",
          },
        });
        return { payload: { stdout: "", stderr: "", exitCode: 0, success: true } };
      }
      if (method === "exec.approval.request") {
        expect(params).toMatchObject({
          id: expect.any(String),
          command: "echo hi",
          host: "node",
          timeoutMs: 120_000,
        });
        approvalId =
          typeof (params as { id?: unknown } | undefined)?.id === "string"
            ? ((params as { id: string }).id ?? null)
            : null;
        return { decision: "allow-once" };
      }
      throw new Error(`unexpected method: ${String(method)}`);
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "nodes");
    if (!tool) {
      throw new Error("missing nodes tool");
    }

    await tool.execute("call1", {
      action: "run",
      node: "mac-1",
      command: ["echo", "hi"],
    });
    expect(invokeCalls).toBe(2);
  });

  it("fails with user denied when approval decision is deny", async () => {
    callGateway.mockImplementation(async ({ method }) => {
      if (method === "node.list") {
        return { nodes: [{ nodeId: "mac-1", commands: ["system.run"] }] };
      }
      if (method === "node.invoke") {
        throw new Error("SYSTEM_RUN_DENIED: approval required");
      }
      if (method === "exec.approval.request") {
        return { decision: "deny" };
      }
      throw new Error(`unexpected method: ${String(method)}`);
    });

    const tool = createOpenClawTools().find((candidate) => candidate.name === "nodes");
    if (!tool) {
      throw new Error("missing nodes tool");
    }

    await expect(
      tool.execute("call1", {
        action: "run",
        node: "mac-1",
        command: ["echo", "hi"],
      }),
    ).rejects.toThrow("exec denied: user denied");
  });

  it("fails closed for timeout and invalid approval decisions", async () => {
    const tool = createOpenClawTools().find((candidate) => candidate.name === "nodes");
    if (!tool) {
      throw new Error("missing nodes tool");
    }

    callGateway.mockImplementation(async ({ method }) => {
      if (method === "node.list") {
        return { nodes: [{ nodeId: "mac-1", commands: ["system.run"] }] };
      }
      if (method === "node.invoke") {
        throw new Error("SYSTEM_RUN_DENIED: approval required");
      }
      if (method === "exec.approval.request") {
        return {};
      }
      throw new Error(`unexpected method: ${String(method)}`);
    });
    await expect(
      tool.execute("call1", {
        action: "run",
        node: "mac-1",
        command: ["echo", "hi"],
      }),
    ).rejects.toThrow("exec denied: approval timed out");

    callGateway.mockImplementation(async ({ method }) => {
      if (method === "node.list") {
        return { nodes: [{ nodeId: "mac-1", commands: ["system.run"] }] };
      }
      if (method === "node.invoke") {
        throw new Error("SYSTEM_RUN_DENIED: approval required");
      }
      if (method === "exec.approval.request") {
        return { decision: "allow-never" };
      }
      throw new Error(`unexpected method: ${String(method)}`);
    });
    await expect(
      tool.execute("call1", {
        action: "run",
        node: "mac-1",
        command: ["echo", "hi"],
      }),
    ).rejects.toThrow("exec denied: invalid approval decision");
  });
});

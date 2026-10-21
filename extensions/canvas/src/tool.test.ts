import type { NodeListNode } from "openclaw/plugin-sdk/agent-harness-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCanvasTool } from "./tool.js";

const mocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(async () => ({})),
  listNodes: vi.fn<() => Promise<NodeListNode[]>>(async () => []),
}));

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>()),
  callGatewayTool: mocks.callGatewayTool,
  listNodes: mocks.listNodes,
}));

const eligibleMac = {
  nodeId: "mac-1",
  displayName: "Studio",
  platform: "macos",
  connected: true,
  commands: ["canvas.present", "canvas.hide", "canvas.navigate"],
};

const actions = [
  { args: { action: "present" }, command: "canvas.present" },
  { args: { action: "navigate", url: "/widget" }, command: "canvas.navigate" },
] as const;

function expectInvoke(params: Record<string, unknown>, opts: unknown = expect.any(Object)) {
  expect(mocks.callGatewayTool).toHaveBeenCalledWith(
    "node.invoke",
    opts,
    expect.objectContaining(params),
  );
}

describe("Canvas presenter tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.callGatewayTool.mockResolvedValue({});
    mocks.listNodes.mockResolvedValue([eligibleMac]);
  });

  it.each(actions)("invokes $command with the default deadline", async ({ args, command }) => {
    const result = await createCanvasTool().execute("tool-call", args);

    expect(mocks.listNodes).toHaveBeenCalledWith({ timeoutMs: undefined });
    expectInvoke(
      { nodeId: "mac-1", command, timeoutMs: 30_000, idempotencyKey: expect.any(String) },
      { timeoutMs: 40_000 },
    );
    expect(result.details).toMatchObject({ ok: true, node: "mac-1" });
  });

  it("preserves present placement and hosted target parameters", async () => {
    const url = "/__openclaw__/canvas/documents/cv_1/index.html";
    const result = await createCanvasTool({ agentSessionKey: "agent:main:panel" }).execute(
      "tool-call",
      {
        action: "present",
        target: url,
        x: "10.5",
        y: "-2",
        width: "640",
        height: "480",
        timeoutMs: "1500",
      },
    );

    expectInvoke(
      {
        command: "canvas.present",
        params: {
          url,
          placement: { x: 10.5, y: -2, width: 640, height: 480 },
        },
        timeoutMs: 1500,
        sessionKey: "agent:main:panel",
      },
      { timeoutMs: 11_500 },
    );
    expect(result.details).toEqual({ ok: true, node: "mac-1", url });
  });

  it("accepts target as the navigate URL alias", async () => {
    const url = "openclaw://widget/local";
    const result = await createCanvasTool().execute("tool-call", {
      action: "navigate",
      target: url,
    });

    expectInvoke({ command: "canvas.navigate", params: { url } });
    expect(result.details).toEqual({ ok: true, node: "mac-1", url });
  });

  it("forwards gateway and node selection options", async () => {
    await createCanvasTool().execute("tool-call", {
      action: "hide",
      gatewayUrl: "ws://gateway.test",
      gatewayToken: "token",
      node: "Studio",
      timeoutMs: 120_000,
    });

    expectInvoke(
      { command: "canvas.hide", timeoutMs: 120_000 },
      {
        gatewayUrl: "ws://gateway.test",
        gatewayToken: "token",
        timeoutMs: 130_000,
      },
    );
  });

  it("rejects an explicit legacy non-macOS Canvas node", async () => {
    mocks.listNodes.mockResolvedValue([
      {
        ...eligibleMac,
        nodeId: "legacy-android",
        displayName: "Old Canvas",
        platform: "android",
        commands: ["canvas.present"],
      },
      eligibleMac,
    ]);

    await expect(
      createCanvasTool().execute("tool-call", { action: "present", node: "legacy-android" }),
    ).rejects.toThrow(
      'node "legacy-android" is not an eligible Canvas panel (requires a connected macOS node advertising canvas.present; eligible node ids: mac-1)',
    );
    expect(mocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it("rejects malformed presenter arguments before invoking a node", async () => {
    const tool = createCanvasTool();

    await expect(tool.execute("tool-call", { action: "present", width: "640px" })).rejects.toThrow(
      "width must be a finite number",
    );
    await expect(tool.execute("tool-call", { action: "navigate" })).rejects.toThrow("url required");
    await expect(tool.execute("tool-call", { action: "removed" })).rejects.toThrow(
      "Unknown action: removed",
    );
    expect(mocks.callGatewayTool).not.toHaveBeenCalled();
  });
});

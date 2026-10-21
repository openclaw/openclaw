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
const localUrl = "openclaw://widget/local";

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

  it.each([
    [{ action: "present" }, "canvas.present", undefined],
    [{ action: "navigate", url: "/widget" }, "canvas.navigate", "/widget"],
    [{ action: "navigate", target: localUrl }, "canvas.navigate", localUrl],
  ] as const)("invokes %j with the default deadline", async (args, command, url) => {
    const result = await createCanvasTool().execute("tool-call", args);

    expect(mocks.listNodes).toHaveBeenCalledWith({ timeoutMs: undefined });
    expectInvoke(
      { nodeId: "mac-1", command, timeoutMs: 30_000, idempotencyKey: expect.any(String) },
      { timeoutMs: 40_000 },
    );
    expect(result.details).toEqual({ ok: true, node: "mac-1", ...(url ? { url } : {}) });
    if (url) {
      expectInvoke({ command, params: { url } });
    }
  });

  it("preserves present placement and hosted target parameters", async () => {
    const url = "/__openclaw__/canvas/documents/cv_1/index.html";
    const placement = { x: "10.5", y: "-2", width: "640", height: "480" };
    const result = await createCanvasTool({ agentSessionKey: "agent:main:panel" }).execute(
      "tool-call",
      { action: "present", target: url, ...placement, timeoutMs: "1500" },
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
      { ...eligibleMac, nodeId: "legacy-android", platform: "android" },
      eligibleMac,
    ]);

    await expect(
      createCanvasTool().execute("tool-call", { action: "present", node: "legacy-android" }),
    ).rejects.toThrow(
      'node "legacy-android" is not an eligible Canvas panel (requires a connected macOS node advertising canvas.present; eligible node ids: mac-1)',
    );
    expect(mocks.callGatewayTool).not.toHaveBeenCalled();
  });

  it.each([
    [{ action: "present", width: "640px" }, "width must be a finite number"],
    [{ action: "navigate" }, "url required"],
    [{ action: "removed" }, "Unknown action: removed"],
  ] as const)("rejects %j before invoking a node", async (args, error) => {
    await expect(createCanvasTool().execute("tool-call", args)).rejects.toThrow(error);
    expect(mocks.callGatewayTool).not.toHaveBeenCalled();
  });
});

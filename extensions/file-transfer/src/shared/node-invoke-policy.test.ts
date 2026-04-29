import type { OpenClawPluginNodeInvokePolicyContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { createFileTransferNodeInvokePolicy } from "./node-invoke-policy.js";

vi.mock("./audit.js", () => ({
  appendFileTransferAudit: vi.fn(async () => undefined),
}));

vi.mock("./policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./policy.js")>();
  return {
    ...actual,
    persistAllowAlways: vi.fn(async () => undefined),
  };
});

function createCtx(overrides: {
  command?: string;
  params?: Record<string, unknown>;
  pluginConfig?: Record<string, unknown>;
  approvals?: OpenClawPluginNodeInvokePolicyContext["approvals"];
}) {
  const invokeNode = vi.fn(async ({ params }: { params?: unknown } = {}) => ({
    ok: true as const,
    payload: {
      ok: true,
      path:
        typeof (params as { path?: unknown } | undefined)?.path === "string"
          ? (params as { path: string }).path
          : "/tmp/file.txt",
      size: 1,
      sha256: "a".repeat(64),
    },
  }));
  return {
    ctx: {
      nodeId: "node-1",
      command: overrides.command ?? "file.fetch",
      params: overrides.params ?? { path: "/tmp/file.txt", maxBytes: 1024 },
      config: {},
      pluginConfig: overrides.pluginConfig ?? {
        nodes: {
          "node-1": {
            allowReadPaths: ["/tmp/**"],
            allowWritePaths: ["/tmp/**"],
            maxBytes: 512,
          },
        },
      },
      node: { nodeId: "node-1", displayName: "Node One" },
      ...(overrides.approvals ? { approvals: overrides.approvals } : {}),
      invokeNode,
    },
    invokeNode,
  };
}

describe("file-transfer node invoke policy", () => {
  it("injects policy-owned limits before invoking the node", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const { ctx, invokeNode } = createCtx({
      command: "file.fetch",
      params: { path: "/tmp/file.txt", maxBytes: 4096, followSymlinks: true },
    });

    const result = await policy.handle(ctx);

    expect(result.ok).toBe(true);
    expect(invokeNode).toHaveBeenCalledWith({
      params: {
        path: "/tmp/file.txt",
        maxBytes: 512,
        followSymlinks: false,
      },
    });
  });

  it("denies raw node.invoke before the node when plugin policy is missing", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const { ctx, invokeNode } = createCtx({ pluginConfig: {} });

    const result = await policy.handle(ctx);

    expect(result).toMatchObject({ ok: false, code: "NO_POLICY" });
    expect(invokeNode).not.toHaveBeenCalled();
  });

  it("uses plugin approvals for ask-on-miss before invoking the node", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const approvals = {
      request: vi.fn(async () => ({ id: "approval-1", decision: "allow-once" as const })),
    };
    const { ctx, invokeNode } = createCtx({
      params: { path: "/tmp/new.txt" },
      pluginConfig: {
        nodes: {
          "node-1": {
            ask: "on-miss",
            allowReadPaths: ["/allowed/**"],
          },
        },
      },
      approvals,
    });

    const result = await policy.handle(ctx);

    expect(result.ok).toBe(true);
    expect(approvals.request).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Read file: /tmp/new.txt",
        severity: "info",
        toolName: "file.fetch",
      }),
    );
    expect(invokeNode).toHaveBeenCalledWith({
      params: {
        path: "/tmp/new.txt",
        followSymlinks: false,
        maxBytes: 8 * 1024 * 1024,
      },
    });
  });

  it("marks node transport failures as unavailable", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const { ctx, invokeNode } = createCtx({
      params: { path: "/tmp/file.txt" },
    });
    invokeNode.mockResolvedValueOnce({
      ok: false,
      code: "TIMEOUT",
      message: "node timed out",
      details: { nodeError: { code: "TIMEOUT" } },
    });

    const result = await policy.handle(ctx);

    expect(result).toMatchObject({
      ok: false,
      code: "TIMEOUT",
      unavailable: true,
      details: { nodeError: { code: "TIMEOUT" } },
    });
  });

  it("rejects a postflight canonical path outside policy", async () => {
    const policy = createFileTransferNodeInvokePolicy();
    const { ctx, invokeNode } = createCtx({
      params: { path: "/tmp/link.txt" },
    });
    invokeNode.mockResolvedValueOnce({
      ok: true,
      payload: {
        ok: true,
        path: "/etc/passwd",
        size: 1,
        sha256: "a".repeat(64),
      },
    });

    const result = await policy.handle(ctx);

    expect(result).toMatchObject({ ok: false, code: "SYMLINK_TARGET_DENIED" });
  });
});

import crypto from "node:crypto";
import type { OpenClawPluginNodeInvokePolicyContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { createFileTransferNodeInvokePolicy } from "./node-invoke-policy.js";

vi.mock("./audit.js", () => ({ appendFileTransferAudit: vi.fn() }));
const binding = { kind: "write", anchorPath: "/workspace", anchorDevice: "1", anchorInode: "2" };
const sizeBytes = 50 * 1024 * 1024;
const expectedSha256 = crypto.createHash("sha256").update("fixture").digest("hex");

function fixture(
  overrides: { maxBytes?: number; allowWritePaths?: string[]; canonical?: string } = {},
) {
  const invokeNode = vi.fn<OpenClawPluginNodeInvokePolicyContext["invokeNode"]>(
    async ({ params } = {}) => {
      const preflight = (params as Record<string, unknown>).preflightOnly === true;
      return {
        ok: true,
        payload: {
          ok: true,
          path: overrides.canonical ?? "/workspace/input",
          binding,
          ...(preflight ? {} : { status: "created" }),
          size: sizeBytes,
          sha256: expectedSha256,
        },
      };
    },
  );
  const ctx: OpenClawPluginNodeInvokePolicyContext = {
    nodeId: "node",
    command: "file.create",
    params: {
      path: "/workspace/input",
      sizeBytes,
      expectedSha256,
      maxBytes: sizeBytes,
      createParents: true,
      followSymlinks: false,
      preflightOnly: true,
      expectedBinding: { forged: true },
      expectedCanonicalPath: "/other",
    },
    config: {},
    pluginConfig: {
      policyVersion: 2,
      nodes: {
        node: {
          ask: "off",
          allowReadPaths: ["/workspace/**"],
          allowWritePaths: overrides.allowWritePaths ?? ["/workspace/**"],
          maxBytes: overrides.maxBytes ?? sizeBytes,
          followSymlinks: true,
        },
      },
    },
    node: { nodeId: "node" },
    invokeNode,
  };
  return { ctx, invokeNode };
}

describe("file.create node policy", () => {
  it("authorizes writes and binds canonical metadata before the duplex effect", async () => {
    const { ctx, invokeNode } = fixture();
    expect(await createFileTransferNodeInvokePolicy().handle(ctx)).toMatchObject({
      ok: true,
      payload: { status: "created" },
    });
    expect(invokeNode).toHaveBeenCalledTimes(2);
    expect(invokeNode.mock.calls[0]?.[0]?.params).toMatchObject({
      sizeBytes,
      maxBytes: sizeBytes,
      followSymlinks: false,
      preflightOnly: true,
    });
    expect(invokeNode.mock.calls[0]?.[0]?.params).not.toHaveProperty("expectedBinding");
    expect(invokeNode.mock.calls[1]?.[0]?.params).toMatchObject({
      expectedCanonicalPath: "/workspace/input",
      expectedBinding: binding,
      expectedSha256,
    });
    expect(invokeNode.mock.calls[1]?.[0]?.params).not.toHaveProperty("preflightOnly");
  });

  it("does not turn a read grant into a create grant", async () => {
    const { ctx, invokeNode } = fixture({ allowWritePaths: [] });
    expect(await createFileTransferNodeInvokePolicy().handle(ctx)).toMatchObject({ ok: false });
    expect(invokeNode).not.toHaveBeenCalled();
  });

  it("honors a smaller configured byte allowance before node dispatch", async () => {
    const { ctx, invokeNode } = fixture({ maxBytes: 16 * 1024 * 1024 });
    expect(await createFileTransferNodeInvokePolicy().handle(ctx)).toMatchObject({
      ok: false,
      code: "INVALID_PARAMS",
    });
    expect(invokeNode).not.toHaveBeenCalled();
  });

  it("rejects canonical escape before invoking the final receiver", async () => {
    const { ctx, invokeNode } = fixture({ canonical: "/outside/input" });
    expect(await createFileTransferNodeInvokePolicy().handle(ctx)).toMatchObject({ ok: false });
    expect(invokeNode).toHaveBeenCalledOnce();
  });

  it.each([
    { sizeBytes: -1 },
    { sizeBytes: 1.5 },
    { expectedSha256: "bad" },
    { maxBytes: Infinity },
  ])("rejects malformed metadata %j before node dispatch", async (params) => {
    const { ctx, invokeNode } = fixture();
    ctx.params = { ...(ctx.params as object), ...params };
    expect(await createFileTransferNodeInvokePolicy().handle(ctx)).toMatchObject({
      ok: false,
      code: "INVALID_PARAMS",
    });
    expect(invokeNode).not.toHaveBeenCalled();
  });
});

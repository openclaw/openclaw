import type { OpenClawPluginNodeInvokePolicyContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { createFileTransferNodeInvokePolicy } from "./node-invoke-policy.js";
import {
  createCtx,
  EXISTING_BINDING,
  requireInvokeParams,
  requireRecord,
} from "./node-invoke-policy.test-support.js";

vi.mock("./audit.js", () => ({ appendFileTransferAudit: vi.fn() }));
const binding = { kind: "write", anchorPath: "/workspace", anchorDevice: "1", anchorInode: "2" };
const sizeBytes = 50 * 1024 * 1024;
const expectedSha256 = "a".repeat(64);

function fixture(overrides: { maxBytes?: number } = {}) {
  const { ctx, invokeNode } = createCtx({
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
    pluginConfig: {
      nodes: {
        "node-1": {
          ask: "off",
          allowReadPaths: ["/workspace/**"],
          allowWritePaths: ["/workspace/**"],
          maxBytes: overrides.maxBytes ?? sizeBytes,
          followSymlinks: true,
        },
      },
    },
  });
  invokeNode.mockImplementation(async ({ params } = {}) => ({
    ok: true,
    payload: {
      ok: true,
      path: "/workspace/input",
      binding,
      ...((params as Record<string, unknown>).preflightOnly === true ? {} : { status: "created" }),
      size: sizeBytes,
      sha256: expectedSha256,
    },
  }));
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

  it("honors a smaller configured byte allowance before node dispatch", async () => {
    const { ctx, invokeNode } = fixture({ maxBytes: 16 * 1024 * 1024 });
    expect(await createFileTransferNodeInvokePolicy().handle(ctx)).toMatchObject({
      ok: false,
      code: "INVALID_PARAMS",
    });
    expect(invokeNode).not.toHaveBeenCalled();
  });

  it.each([{ sizeBytes: -1 }, { expectedSha256: "bad" }, { maxBytes: Infinity }])(
    "rejects malformed metadata %j before node dispatch",
    async (params) => {
      const { ctx, invokeNode } = fixture();
      ctx.params = { ...(ctx.params as object), ...params };
      expect(await createFileTransferNodeInvokePolicy().handle(ctx)).toMatchObject({
        ok: false,
        code: "INVALID_PARAMS",
      });
      expect(invokeNode).not.toHaveBeenCalled();
    },
  );
});

const size = 32 * 1024 * 1024;

describe("binary file.fetch policy", () => {
  it("retains canonical approval and the configured byte cap", async () => {
    const maxBytes = 20 * 1024 * 1024;
    const { ctx, invokeNode } = createCtx({
      params: {
        path: "/tmp/output",
        transport: "binary",
        maxBytes: size,
        followSymlinks: true,
        preflightOnly: true,
        expectedCanonicalPath: "/forged",
        expectedBinding: { forged: true },
      },
      pluginConfig: {
        nodes: { "node-1": { ask: "off", allowReadPaths: ["/tmp/**"], maxBytes } },
      },
    });
    expect(await createFileTransferNodeInvokePolicy().handle(ctx)).toMatchObject({ ok: true });
    expect(invokeNode).toHaveBeenCalledTimes(2);
    expect(requireInvokeParams(invokeNode, 0)).toMatchObject({
      transport: "binary",
      maxBytes,
      followSymlinks: false,
      preflightOnly: true,
    });
    expect(requireInvokeParams(invokeNode, 0)).not.toHaveProperty("expectedBinding");
    expect(requireInvokeParams(invokeNode, 1)).toMatchObject({
      transport: "binary",
      maxBytes,
      followSymlinks: false,
      expectedCanonicalPath: "/tmp/output",
      expectedBinding: EXISTING_BINDING,
    });
    expect(requireInvokeParams(invokeNode, 1)).not.toHaveProperty("preflightOnly");
  });

  it("rejects unknown modes and unsafe binary budgets before node dispatch", async () => {
    for (const extra of [{ transport: "other" }, { maxBytes: Number.MAX_SAFE_INTEGER + 1 }]) {
      const approvals = { request: vi.fn() };
      const { ctx, invokeNode } = createCtx({
        params: { path: "/tmp/output", transport: "binary", maxBytes: size, ...extra },
        approvals,
      });
      expect(await createFileTransferNodeInvokePolicy().handle(ctx)).toMatchObject({
        ok: false,
        code: "INVALID_PARAMS",
      });
      expect(invokeNode).not.toHaveBeenCalled();
      expect(approvals.request).not.toHaveBeenCalled();
    }
  });
});

describe("file-transfer preflight identity", () => {
  it("fails closed when a node preflight omits filesystem identity", async () => {
    const invokeNode = vi.fn<OpenClawPluginNodeInvokePolicyContext["invokeNode"]>(async () => ({
      ok: true,
      payload: { ok: true, path: "/tmp/file.txt", size: 1 },
    }));
    const ctx: OpenClawPluginNodeInvokePolicyContext = {
      nodeId: "node-1",
      command: "file.fetch",
      params: { path: "/tmp/file.txt" },
      config: {},
      pluginConfig: {
        policyVersion: 2,
        nodes: { "node-1": { allowReadPaths: ["/tmp/**"] } },
      },
      node: { nodeId: "node-1" },
      invokeNode,
    };

    const result = await createFileTransferNodeInvokePolicy().handle(ctx);

    expect(result).toMatchObject({ ok: false, code: "FILESYSTEM_IDENTITY_MISSING" });
    expect(invokeNode).toHaveBeenCalledOnce();
  });
});

describe("file-transfer dir.list policy", () => {
  it("reapproves a stale grant before listing and binds the retry", async () => {
    const events: string[] = [];
    const approvals = {
      request: vi.fn(async () => {
        events.push("approval");
        return { id: "approval-1", decision: "allow-once" as const };
      }),
    };
    const invokeNode = vi.fn<OpenClawPluginNodeInvokePolicyContext["invokeNode"]>(
      async ({ params } = {}) => {
        const record = requireRecord(params, "invoke params");
        events.push(record.preflightOnly === true ? "preflight" : "list");
        if (record.preflightOnly === true && record.expectedCanonicalPath === "/tmp/old-project") {
          return {
            ok: true,
            payload: {
              ok: false,
              code: "CANONICAL_PATH_CHANGED",
              message: "canonical path differs from the authorized target",
              canonicalPath: "/tmp/new-project",
            },
          };
        }
        return {
          ok: true,
          payload: { ok: true, binding: EXISTING_BINDING, path: "/tmp/new-project", entries: [] },
        };
      },
    );
    const ctx: OpenClawPluginNodeInvokePolicyContext = {
      nodeId: "node-1",
      command: "dir.list",
      params: { path: "/tmp/project", expectedCanonicalPath: "/tmp/injected" },
      config: {},
      pluginConfig: {
        policyVersion: 2,
        nodes: { "node-1": { ask: "on-miss", followSymlinks: true } },
        literalGrants: [
          {
            nodeId: "node-1",
            command: "dir.list",
            requestedPath: "/tmp/project",
            canonicalPath: "/tmp/old-project",
          },
        ],
      },
      node: { nodeId: "node-1", displayName: "Node One" },
      approvals,
      invokeNode,
    };

    expect((await createFileTransferNodeInvokePolicy().handle(ctx)).ok).toBe(true);
    expect(events).toEqual(["preflight", "approval", "preflight", "list"]);
    expect(invokeNode).toHaveBeenNthCalledWith(1, {
      params: {
        path: "/tmp/project",
        followSymlinks: true,
        preflightOnly: true,
        expectedCanonicalPath: "/tmp/old-project",
      },
    });
    expect(invokeNode).toHaveBeenNthCalledWith(2, {
      params: {
        path: "/tmp/project",
        followSymlinks: true,
        preflightOnly: true,
        expectedCanonicalPath: "/tmp/new-project",
      },
    });
    expect(invokeNode).toHaveBeenNthCalledWith(3, {
      params: {
        path: "/tmp/project",
        followSymlinks: true,
        expectedCanonicalPath: "/tmp/new-project",
        expectedBinding: EXISTING_BINDING,
      },
    });
  });
});

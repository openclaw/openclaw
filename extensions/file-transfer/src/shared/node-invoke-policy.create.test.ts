import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const policy = createFileTransferNodeInvokePolicy();

beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(clearRuntimeConfigSnapshot);

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
  invokeNode.mockImplementation(async ({ params }: Parameters<typeof invokeNode>[0] = {}) => ({
    ok: true,
    payload: {
      ok: true,
      path: "/workspace/input",
      binding,
      ...(requireRecord(params, "invoke params").preflightOnly === true
        ? {}
        : { status: "created" }),
      size: sizeBytes,
      sha256: expectedSha256,
    },
  }));
  return { ctx, invokeNode };
}

async function expectInvalid(
  ctx: ReturnType<typeof createCtx>["ctx"],
  invokeNode: ReturnType<typeof createCtx>["invokeNode"],
) {
  expect(await policy.handle(ctx)).toMatchObject({ ok: false, code: "INVALID_PARAMS" });
  expect(invokeNode).not.toHaveBeenCalled();
}

describe("file.create node policy", () => {
  it("authorizes writes and binds canonical metadata before the duplex effect", async () => {
    const { ctx, invokeNode } = fixture();
    expect(await policy.handle(ctx)).toMatchObject({
      ok: true,
      payload: { status: "created" },
    });
    expect(invokeNode).toHaveBeenCalledTimes(2);
    const preflight = requireInvokeParams(invokeNode, 0);
    const final = requireInvokeParams(invokeNode, 1);
    expect(preflight).toMatchObject({
      sizeBytes,
      maxBytes: sizeBytes,
      followSymlinks: false,
      preflightOnly: true,
    });
    expect(preflight).not.toHaveProperty("expectedBinding");
    expect(final).toMatchObject({
      expectedCanonicalPath: "/workspace/input",
      expectedBinding: binding,
      expectedSha256,
    });
    expect(final).not.toHaveProperty("preflightOnly");
  });

  it("honors a smaller configured byte allowance before node dispatch", async () => {
    const { ctx, invokeNode } = fixture({ maxBytes: 16 * 1024 * 1024 });
    await expectInvalid(ctx, invokeNode);
  });

  it.each([{ sizeBytes: -1 }, { expectedSha256: "bad" }, { maxBytes: Infinity }])(
    "rejects malformed metadata %j before node dispatch",
    async (params) => {
      const { ctx, invokeNode } = fixture();
      ctx.params = { ...(ctx.params as object), ...params };
      await expectInvalid(ctx, invokeNode);
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
    expect(await policy.handle(ctx)).toMatchObject({ ok: true });
    const fields = { transport: "binary", maxBytes, followSymlinks: false };
    expect(invokeNode).toHaveBeenCalledTimes(2);
    const preflight = requireInvokeParams(invokeNode, 0);
    const final = requireInvokeParams(invokeNode, 1);
    expect(preflight).toMatchObject({ ...fields, preflightOnly: true });
    expect(preflight).not.toHaveProperty("expectedBinding");
    expect(final).toMatchObject({
      ...fields,
      expectedCanonicalPath: "/tmp/output",
      expectedBinding: EXISTING_BINDING,
    });
    expect(final).not.toHaveProperty("preflightOnly");
  });

  it("rejects unknown modes and unsafe binary budgets before node dispatch", async () => {
    for (const extra of [{ transport: "other" }, { maxBytes: Number.MAX_SAFE_INTEGER + 1 }]) {
      const approvals = { request: vi.fn() };
      const { ctx, invokeNode } = createCtx({
        params: { path: "/tmp/output", transport: "binary", maxBytes: size, ...extra },
        approvals,
      });
      await expectInvalid(ctx, invokeNode);
      expect(approvals.request).not.toHaveBeenCalled();
    }
  });
});

it("fails closed when a node preflight omits filesystem identity", async () => {
  const { ctx, invokeNode } = createCtx({
    params: { path: "/tmp/file.txt" },
    pluginConfig: {
      nodes: { "node-1": { allowReadPaths: ["/tmp/**"] } },
    },
  });
  invokeNode.mockResolvedValue({
    ok: true,
    payload: { ok: true, path: "/tmp/file.txt", size: 1 },
  });
  expect(await policy.handle(ctx)).toMatchObject({
    ok: false,
    code: "FILESYSTEM_IDENTITY_MISSING",
  });
  expect(invokeNode).toHaveBeenCalledOnce();
});
it("dir.list reapproves a stale grant before listing and binds the retry", async () => {
  const events: string[] = [];
  const approvals = {
    request: vi.fn(async () => {
      events.push("approval");
      return { id: "approval-1", decision: "allow-once" as const };
    }),
  };
  const { ctx, invokeNode } = createCtx({
    command: "dir.list",
    params: { path: "/tmp/project", expectedCanonicalPath: "/tmp/injected" },
    pluginConfig: {
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
    approvals,
  });
  invokeNode.mockImplementation(async ({ params }: Parameters<typeof invokeNode>[0] = {}) => {
    const record = requireRecord(params, "invoke params");
    events.push(record.preflightOnly === true ? "preflight" : "list");
    return {
      ok: true,
      payload:
        record.preflightOnly === true && record.expectedCanonicalPath === "/tmp/old-project"
          ? {
              ok: false,
              code: "CANONICAL_PATH_CHANGED",
              message: "canonical path differs from the authorized target",
              canonicalPath: "/tmp/new-project",
            }
          : { ok: true, binding: EXISTING_BINDING, path: "/tmp/new-project", entries: [] },
    };
  });

  expect((await policy.handle(ctx)).ok).toBe(true);
  expect(events).toEqual(["preflight", "approval", "preflight", "list"]);
  const params = {
    path: "/tmp/project",
    followSymlinks: true,
    expectedCanonicalPath: "/tmp/new-project",
  };
  expect(invokeNode.mock.calls).toEqual([
    [{ params: { ...params, preflightOnly: true, expectedCanonicalPath: "/tmp/old-project" } }],
    [{ params: { ...params, preflightOnly: true } }],
    [{ params: { ...params, expectedBinding: EXISTING_BINDING } }],
  ]);
});

// File Transfer tests cover lazy node invoke policy plugin behavior.
import type {
  OpenClawPluginNodeInvokePolicy,
  OpenClawPluginNodeInvokePolicyContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLazyFileTransferNodeInvokePolicy } from "./lazy-node-invoke-policy.js";

const createPolicy = vi.hoisted(() => vi.fn<() => OpenClawPluginNodeInvokePolicy>());
vi.mock("./node-invoke-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./node-invoke-policy.js")>()),
  createFileTransferNodeInvokePolicy: createPolicy,
}));
beforeEach(() => createPolicy.mockReset());

function createPolicyContext(
  overrides: Partial<OpenClawPluginNodeInvokePolicyContext> = {},
): OpenClawPluginNodeInvokePolicyContext {
  return {
    nodeId: "node-1",
    command: "file.fetch",
    params: { path: "/tmp/a.txt" },
    config: {} as never,
    pluginConfig: {},
    node: {
      nodeId: "node-1",
      displayName: "Test Node",
      commands: ["file.fetch"],
    },
    client: null,
    invokeNode: vi.fn<OpenClawPluginNodeInvokePolicyContext["invokeNode"]>(async () => ({
      ok: true,
      payload: { ok: true },
      payloadJSON: null,
    })),
    ...overrides,
  };
}

describe("lazy file-transfer node invoke policy", () => {
  it("exposes command metadata without loading the delegate", () => {
    const policy = createLazyFileTransferNodeInvokePolicy();

    expect(policy.commands).toEqual([
      "file.fetch",
      "file.stat",
      "dir.list",
      "dir.fetch",
      "file.write",
      "file.create",
    ]);
    expect(createPolicy).not.toHaveBeenCalled();
  });

  it("loads and caches the delegate on first handle", async () => {
    const invokeNode = vi.fn<OpenClawPluginNodeInvokePolicyContext["invokeNode"]>(async () => ({
      ok: true,
      payload: { ok: true },
      payloadJSON: null,
    }));
    const delegateHandle = vi.fn<OpenClawPluginNodeInvokePolicy["handle"]>(async (ctx) => {
      await ctx.invokeNode();
      return { ok: true, payload: { delegated: true } };
    });
    createPolicy.mockReturnValue({
      commands: ["file.fetch"],
      handle: delegateHandle,
    });
    const policy = createLazyFileTransferNodeInvokePolicy();

    await expect(policy.handle(createPolicyContext({ invokeNode }))).resolves.toEqual({
      ok: true,
      payload: { delegated: true },
    });
    await expect(policy.handle(createPolicyContext({ invokeNode }))).resolves.toEqual({
      ok: true,
      payload: { delegated: true },
    });

    expect(createPolicy).toHaveBeenCalledTimes(1);
    expect(delegateHandle).toHaveBeenCalledTimes(2);
    expect(invokeNode).toHaveBeenCalledTimes(2);
  });

  it("does not rewrite delegate failures as load failures", async () => {
    const delegateError = new Error("delegate failed");
    createPolicy.mockReturnValue({
      commands: ["file.fetch"],
      handle: async () => {
        throw delegateError;
      },
    });
    const policy = createLazyFileTransferNodeInvokePolicy();

    await expect(policy.handle(createPolicyContext())).rejects.toBe(delegateError);
  });
});

import { describe, expect, it, vi } from "vitest";
import { createFileTransferNodeInvokePolicy } from "./node-invoke-policy.js";
import {
  createCtx,
  EXISTING_BINDING,
  requireInvokeParams,
} from "./node-invoke-policy.test-support.js";

vi.mock("./audit.js", () => ({ appendFileTransferAudit: vi.fn() }));
const size = 32 * 1024 * 1024;

describe("binary file.fetch policy", () => {
  it.each([undefined, 20 * 1024 * 1024])(
    "retains canonical approval and the configured %s byte cap",
    async (maxBytes) => {
      const { ctx, invokeNode } = createCtx({
        params: {
          path: "/tmp/output",
          transport: "binary",
          maxBytes: size,
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
        maxBytes: maxBytes ?? size,
        preflightOnly: true,
      });
      expect(requireInvokeParams(invokeNode, 0)).not.toHaveProperty("expectedBinding");
      expect(requireInvokeParams(invokeNode, 1)).toMatchObject({
        transport: "binary",
        maxBytes: maxBytes ?? size,
        expectedCanonicalPath: "/tmp/output",
        expectedBinding: EXISTING_BINDING,
      });
    },
  );

  it("rejects unknown modes and unsafe binary budgets before node dispatch", async () => {
    for (const extra of [{ transport: "other" }, { maxBytes: Number.MAX_SAFE_INTEGER + 1 }]) {
      const { ctx, invokeNode } = createCtx({
        params: { path: "/tmp/output", transport: "binary", maxBytes: size, ...extra },
      });
      expect(await createFileTransferNodeInvokePolicy().handle(ctx)).toMatchObject({
        ok: false,
        code: "INVALID_PARAMS",
      });
      expect(invokeNode).not.toHaveBeenCalled();
    }
  });
});

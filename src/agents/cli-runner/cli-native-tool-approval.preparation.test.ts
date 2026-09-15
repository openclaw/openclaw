import { beforeEach, describe, expect, it, vi } from "vitest";
import { requestCliNativeToolApproval } from "./cli-native-tool-approval.js";

const mocks = vi.hoisted(() => ({ prepare: vi.fn(), revalidate: vi.fn(), gateway: vi.fn() }));
vi.mock("../../infra/system-run-approval-binding.js", () => ({
  prepareSystemRunMutableFileBinding: mocks.prepare,
  revalidateSystemRunMutableFileBinding: mocks.revalidate,
}));
vi.mock("../tools/gateway.js", () => ({ callGatewayTool: mocks.gateway }));

const shapeError =
  "SYSTEM_RUN_DENIED: approval cannot safely bind this interpreter/runtime command";
const request = {
  toolName: "Bash",
  toolInput: { command: "printf approval-probe" },
  pluginId: "claude-cli",
  ask: "always" as const,
};

describe("native approval preparation guidance", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.prepare.mockResolvedValue({ ok: true, binding: { operands: [] } });
    mocks.revalidate.mockResolvedValue({ ok: true });
    mocks.gateway.mockResolvedValue({ id: "approval-probe", decision: "allow-once" });
  });

  it("explains a shape refusal before any approval RPC without granting execution", async () => {
    mocks.prepare.mockResolvedValue({ ok: false, message: shapeError });
    const outcome = await requestCliNativeToolApproval(request);
    expect(outcome).toMatchObject({ kind: "deny", reason: "operand-binding" });
    expect(outcome).toHaveProperty("message", expect.stringContaining(shapeError));
    expect(outcome).toHaveProperty(
      "message",
      expect.stringContaining("No approval request was created"),
    );
    expect(outcome).toHaveProperty("message", expect.stringContaining("this is not a user denial"));
    expect(outcome).toHaveProperty("message", expect.stringContaining("one command at a time"));
    expect(outcome).toHaveProperty("message", expect.stringContaining("normal approval flow"));
    expect(mocks.gateway).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it.each([
    "SYSTEM_RUN_DENIED: approval requires a stable executable path",
    "SYSTEM_RUN_DENIED: script operand does not exist",
    "command required",
  ])("does not relabel a different failure: %s", async (message) => {
    mocks.prepare.mockResolvedValue({ ok: false, message });
    const outcome = await requestCliNativeToolApproval(request);
    expect(outcome).toMatchObject({ kind: "deny", reason: "operand-binding" });
    expect(outcome).toHaveProperty("message", expect.stringContaining(message));
    expect(outcome).not.toHaveProperty(
      "message",
      expect.stringContaining("No approval request was created"),
    );
    expect(mocks.gateway).not.toHaveBeenCalled();
  });

  it("retains the ordinary approved request and does not allow-always for Bash", async () => {
    await expect(requestCliNativeToolApproval(request)).resolves.toEqual({
      kind: "allow",
      grantAlways: false,
    });
    expect(mocks.gateway).toHaveBeenCalledOnce();
    expect(mocks.gateway).toHaveBeenCalledWith(
      "plugin.approval.request",
      expect.any(Object),
      expect.objectContaining({ allowedDecisions: ["allow-once", "deny"] }),
      expect.any(Object),
    );
  });

  it("retains an actual human denial", async () => {
    mocks.gateway.mockResolvedValue({ id: "approval-probe", decision: "deny" });
    await expect(requestCliNativeToolApproval(request)).resolves.toEqual({
      kind: "deny",
      reason: "user",
    });
    expect(mocks.gateway).toHaveBeenCalledOnce();
  });

  it("does not claim no request existed when revalidation fails after approval", async () => {
    mocks.prepare.mockResolvedValue({
      ok: true,
      binding: { operands: [{ path: "/synthetic/probe.sh" }] },
    });
    mocks.revalidate.mockResolvedValue({ ok: false, message: shapeError });
    await expect(requestCliNativeToolApproval(request)).resolves.toEqual({
      kind: "deny",
      reason: "operand-binding",
      message: shapeError,
    });
    expect(mocks.gateway).toHaveBeenCalledOnce();
    expect(mocks.revalidate).toHaveBeenCalledOnce();
  });

  it("preserves pre-existing oversized-command rejection", async () => {
    await expect(
      requestCliNativeToolApproval({
        ...request,
        toolInput: { command: "x".repeat(600) },
      }),
    ).resolves.toEqual({ kind: "deny", reason: "policy-oversized" });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.gateway).not.toHaveBeenCalled();
  });
});

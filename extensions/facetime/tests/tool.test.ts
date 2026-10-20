import { describe, expect, it, vi } from "vitest";
import { createFaceTimeCallTool, resolveFaceTimeToolApproval } from "../src/tool.js";

function createTool() {
  const runtime = {
    status: vi.fn(async () => ({
      enabled: true as const,
      helperConnected: true,
      helperProtocol: {
        version: 1 as const,
        authentication: "mutual-hmac-sha256-v1" as const,
        eventIntegrity: "epoch-sequence-hmac-v1" as const,
        statusClassifier: "explicit-ended-tu-call-status-v1" as const,
        transportClassifier: "tu-provider-v1" as const,
      },
      helperTargets: [
        {
          target: "FaceTime" as const,
          connected: true,
          attempts: 0,
          injecting: false,
          queued: false,
          retryScheduled: false,
          stale: false,
        },
      ],
      driverInstallPending: false,
      driverInstall: { phase: "idle" as const },
      processOutputSuppressed: false,
      calls: [],
    })),
    preflight: vi.fn(async () => ({
      ok: true,
      helperConnected: true,
      checks: [{ id: "helper-connected", label: "Helper", ok: true, required: true }],
    })),
    dial: vi.fn(async () => ({
      dialID: "dial-1",
      state: "pending" as const,
      handle: "owner@example.com",
      mode: "audio" as const,
      helper: { internal: "not-model-visible" },
    })),
    hangup: vi.fn(async () => ({ callUUID: "call-1" })),
  };
  const ensureRuntime = vi.fn(async () => runtime);
  const tool = createFaceTimeCallTool({
    ensureRuntime,
    getStatus: async () => await runtime.status(),
  });
  return {
    runtime,
    ensureRuntime,
    execute: async (input: Parameters<typeof tool.execute>[1]) =>
      (await tool.execute("tool-1", input)).details,
  };
}

describe("FaceTime agent tool", () => {
  it("returns a compact runtime status", async () => {
    const { execute, ensureRuntime } = createTool();
    expect(await execute({ action: "get_status" })).toMatchObject({
      ok: true,
      action: "get_status",
      status: {
        helperConnected: true,
        driverInstallPending: false,
        calls: [],
      },
    });
    expect(ensureRuntime).not.toHaveBeenCalled();
  });

  it("requires trusted one-shot approval for outbound dialing", () => {
    expect(
      resolveFaceTimeToolApproval({
        action: "initiate_call",
        handle: "owner@example.com",
        mode: "video",
      }),
    ).toEqual({
      requireApproval: {
        title: "Place FaceTime call",
        description: "Place a video FaceTime call to owner@example.com.",
        severity: "warning",
        allowedDecisions: ["allow-once", "deny"],
        timeoutMs: 120_000,
      },
    });
    expect(resolveFaceTimeToolApproval({ action: "get_status" })).toBeUndefined();
  });

  it("dials an authorized owner target without exposing helper internals", async () => {
    const { runtime, execute } = createTool();
    const target = { handle: "owner@example.com", mode: "audio" };
    const result = await execute({ action: "initiate_call", ...target });
    expect(runtime.dial).toHaveBeenCalledWith(target);
    expect(result).toEqual({
      ok: true,
      action: "initiate_call",
      dialID: "dial-1",
      state: "pending",
      ...target,
    });
  });

  it("checks readiness and ends the current call", async () => {
    const { runtime, execute } = createTool();
    expect(await execute({ action: "check_readiness" })).toMatchObject({
      ok: true,
      status: { helperConnected: true },
    });
    expect(await execute({ action: "end_call", callUUID: "call-1" })).toEqual({
      ok: true,
      action: "end_call",
      callUUID: "call-1",
    });
    expect(runtime.hangup).toHaveBeenCalledWith({ callUUID: "call-1" });
  });
});

import { describe, expect, it, vi } from "vitest";
import { createFaceTimeCallTool, resolveFaceTimeToolApproval } from "../src/tool.js";

function details(result: unknown) {
  return (result as { details: Record<string, unknown> }).details;
}

function runtime() {
  return {
    status: vi.fn(async () => ({
      enabled: true as const,
      controlMode: "operator-assisted" as const,
      admissionModel: "authenticated-operator-confirms-configured-owner" as const,
      carrierHangupSupported: false as const,
      driverInstallPending: false,
      driverInstall: { phase: "idle" as const },
      processOutputSuppressed: false,
      calls: [],
    })),
    preflight: vi.fn(async () => ({
      ok: true,
      controlMode: "operator-assisted" as const,
      checks: [],
    })),
    dial: vi.fn(async () => ({
      dialID: "dial-1",
      state: "operator-action-required" as const,
      handle: "owner@example.com",
      mode: "video" as const,
      guidance: "Confirm the call, then attach.",
    })),
    attach: vi.fn(async () => ({
      callUUID: "call-1",
      state: "attached" as const,
      handle: "owner@example.com",
      mode: "video" as const,
      admission: "operator-confirmed-owner" as const,
    })),
    hangup: vi.fn(async () => ({
      callUUID: "call-1",
      detached: true as const,
      manualHangupRequired: true as const,
    })),
  };
}

describe("FaceTime operator-assisted tool", () => {
  it("requires separate one-shot approvals to open and attach", () => {
    expect(
      resolveFaceTimeToolApproval({
        action: "initiate_call",
        handle: "owner@example.com",
        mode: "video",
      }),
    ).toMatchObject({
      requireApproval: { title: "Open FaceTime call", allowedDecisions: ["allow-once", "deny"] },
    });
    expect(
      resolveFaceTimeToolApproval({
        action: "attach_current_call",
        handle: "owner@example.com",
        mode: "video",
      }),
    ).toMatchObject({
      requireApproval: {
        title: "Attach to FaceTime call",
        allowedDecisions: ["allow-once", "deny"],
      },
    });
  });

  it("attaches only through the explicit attach action", async () => {
    const value = runtime();
    const tool = createFaceTimeCallTool({
      ensureRuntime: async () => value,
      getStatus: value.status,
    });
    const result = details(
      await tool.execute("tool-1", {
        action: "attach_current_call",
        handle: "owner@example.com",
        mode: "video",
      }),
    );
    expect(value.attach).toHaveBeenCalledWith({ handle: "owner@example.com", mode: "video" });
    expect(result).toMatchObject({
      ok: true,
      state: "attached",
      admission: "operator-confirmed-owner",
    });
  });

  it("reports detach honestly without claiming carrier hangup", async () => {
    const value = runtime();
    const tool = createFaceTimeCallTool({
      ensureRuntime: async () => value,
      getStatus: value.status,
    });
    expect(details(await tool.execute("tool-2", { action: "end_call" }))).toMatchObject({
      ok: true,
      detached: true,
      manualHangupRequired: true,
    });
  });
});

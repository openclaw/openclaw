import { expect, it, vi } from "vitest";
import { FaceTimeCallRegistry } from "../src/runtime-state.js";
import { buildFaceTimeRuntimeStatus } from "../src/runtime-status.js";
import type { FaceTimeRuntime } from "../src/runtime.js";
import { createFaceTimeCallTool, resolveFaceTimeToolApproval } from "../src/tool.js";

function createTool() {
  const runtime = {
    status: async () =>
      buildFaceTimeRuntimeStatus({
        calls: new FaceTimeCallRegistry(),
        helperConnected: true,
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
        driverInstall: { phase: "idle" },
      }),
    preflight: vi.fn<FaceTimeRuntime["preflight"]>(),
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

it.each(["get_status", "check_readiness"])("returns compact status for %s", async (action) => {
  const { execute, ensureRuntime } = createTool();
  expect(await execute({ action })).toMatchObject({
    ok: true,
    action,
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
  expect(await execute({ action: "initiate_call", ...target })).toEqual({
    ok: true,
    action: "initiate_call",
    dialID: "dial-1",
    state: "pending",
    ...target,
  });
  expect(runtime.dial).toHaveBeenCalledWith(target);
});

it("ends the current call", async () => {
  const { runtime, execute } = createTool();
  expect(await execute({ action: "end_call", callUUID: "call-1" })).toEqual({
    ok: true,
    action: "end_call",
    callUUID: "call-1",
  });
  expect(runtime.hangup).toHaveBeenCalledWith({ callUUID: "call-1" });
});

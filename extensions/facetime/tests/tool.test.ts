import { beforeEach, expect, it, vi } from "vitest";
import { FaceTimeCallRegistry } from "../src/runtime-state.js";
import { buildFaceTimeRuntimeStatus } from "../src/runtime-status.js";
import type { FaceTimeRuntime } from "../src/runtime.js";
import { createFaceTimeCallTool, resolveFaceTimeToolApproval } from "../src/tool.js";

const runtime = {
  status: async () =>
    buildFaceTimeRuntimeStatus({
      calls: new FaceTimeCallRegistry(),
      helperConnected: true,
      helperTargets: [],
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
  getStatus: runtime.status,
});
const execute = async (input: Parameters<typeof tool.execute>[1]) =>
  (await tool.execute("tool-1", input)).details;
beforeEach(() => vi.clearAllMocks());

it.each(["get_status", "check_readiness"])("returns compact status for %s", async (action) => {
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

it("requires trusted one-shot approval for click-to-call dialing", () => {
  expect(
    resolveFaceTimeToolApproval({
      action: "initiate_click_to_call",
      handle: "owner@example.com",
      mode: "audio",
    }),
  ).toEqual({
    requireApproval: {
      title: "Place FaceTime call via click-to-call",
      description:
        "Place a audio FaceTime call to owner@example.com by pressing the macOS click-to-call card.",
      severity: "warning",
      allowedDecisions: ["allow-once", "deny"],
      timeoutMs: 120_000,
    },
  });
});

it("places a click-to-call call through the injected carrier", async () => {
  const clickToCall = vi.fn(async () => ({
    placed: true,
    live: true,
    detail: "FaceTime Audio - 0:03",
  }));
  const clickTool = createFaceTimeCallTool({
    ensureRuntime,
    getStatus: runtime.status,
    clickToCall,
  });
  const clickExecute = async (input: Parameters<typeof clickTool.execute>[1]) =>
    (await clickTool.execute("tool-2", input)).details;

  expect(
    await clickExecute({
      action: "initiate_click_to_call",
      handle: "owner@example.com",
      mode: "audio",
    }),
  ).toEqual({
    ok: true,
    action: "initiate_click_to_call",
    placed: true,
    live: true,
    detail: "FaceTime Audio - 0:03",
  });
  expect(clickToCall).toHaveBeenCalledWith({
    handle: "owner@example.com",
    mode: "audio",
  });
  expect(ensureRuntime).not.toHaveBeenCalled();
});

it("refuses click-to-call dialing without a handle", async () => {
  const clickToCall = vi.fn(async () => ({
    placed: true,
    live: true,
    detail: "unused",
  }));
  const clickTool = createFaceTimeCallTool({
    ensureRuntime,
    getStatus: runtime.status,
    clickToCall,
  });
  const result = await clickTool.execute("tool-3", { action: "initiate_click_to_call" });
  expect(result.details).toMatchObject({
    ok: false,
    error: "handle is required",
  });
  expect(clickToCall).not.toHaveBeenCalled();
});

it("ends the current call", async () => {
  expect(await execute({ action: "end_call", callUUID: "call-1" })).toEqual({
    ok: true,
    action: "end_call",
    callUUID: "call-1",
  });
  expect(runtime.hangup).toHaveBeenCalledWith({ callUUID: "call-1" });
});

import { jsonResult as json } from "openclaw/plugin-sdk/tool-results";
import { Type } from "typebox";
import { formatErrorMessage } from "./errors.js";
import type { FaceTimeRuntime, FaceTimeRuntimeStatus } from "./runtime.js";

const FaceTimeCallToolSchema = Type.Union([
  Type.Object({ action: Type.Literal("get_status") }, { additionalProperties: false }),
  Type.Object({ action: Type.Literal("check_readiness") }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal("initiate_call"),
      handle: Type.String({
        description: "Allowlisted FaceTime email address or phone number",
        maxLength: 256,
      }),
      mode: Type.Optional(
        Type.Union([Type.Literal("audio"), Type.Literal("video")], {
          description: "Call mode. Defaults to audio.",
        }),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("end_call"),
      callUUID: Type.Optional(
        Type.String({
          description: "Active call UUID. Omit to end the current active or pending call.",
        }),
      ),
    },
    { additionalProperties: false },
  ),
]);

type FaceTimeToolRuntime = Pick<FaceTimeRuntime, "status" | "preflight" | "dial" | "hangup">;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveFaceTimeToolApproval(input: unknown) {
  const raw = asRecord(input);
  if (raw.action !== "initiate_call") {
    return;
  }
  const handle = optionalString(raw.handle);
  if (!handle) {
    return;
  }
  const mode = raw.mode === "video" ? "video" : "audio";
  return {
    requireApproval: {
      title: "Place FaceTime call",
      description: `Place a ${mode} FaceTime call to ${handle}.`,
      severity: "warning" as const,
      // A phone call is never safe to approve durably. Bind consent to this invocation.
      allowedDecisions: ["allow-once", "deny"] as Array<"allow-once" | "deny">,
      timeoutMs: 120_000,
    },
  };
}

function summarizeStatus(status: FaceTimeRuntimeStatus) {
  return {
    enabled: status.enabled,
    helperConnected: status.helperConnected,
    helperTargets: status.helperTargets.map((target) => ({
      target: target.target,
      connected: target.connected,
      stale: target.stale,
      retryScheduled: target.retryScheduled,
    })),
    driverInstallPending: status.driverInstallPending,
    driverInstall: status.driverInstall,
    processOutputSuppressed: status.processOutputSuppressed,
    outboundCallPending: status.outboundCallPending,
    calls: status.calls.map((call) => ({
      callUUID: call.callUUID,
      handle: call.handle,
      realtimeActive: call.realtimeActive,
      audioReady: call.audioReady,
      processInputVerified: call.audioTransport?.processInputVerified === true,
      processOutputSuppressed: call.audioTransport?.processOutputSuppressed === true,
      lastRoutingError: call.lastRoutingError,
      carrierHangupPending: call.carrierHangupPending,
    })),
  };
}

export function createFaceTimeCallTool(params: {
  ensureRuntime: () => Promise<FaceTimeToolRuntime>;
}) {
  return {
    name: "facetime_call",
    label: "FaceTime Call",
    description:
      "Check FaceTime readiness and manage allowlisted FaceTime calls on the signed-in OpenClaw Mac.",
    parameters: FaceTimeCallToolSchema,
    async execute(_toolCallId: string, input: unknown) {
      const raw = asRecord(input);
      const action = optionalString(raw.action);
      try {
        const runtime = await params.ensureRuntime();
        switch (action) {
          case "get_status":
            return json({
              ok: true,
              action,
              status: summarizeStatus(await runtime.status()),
            });
          case "check_readiness": {
            const readiness = await runtime.preflight();
            return json({
              ok: readiness.ok,
              action,
              helperConnected: readiness.helperConnected,
              checks: readiness.checks,
            });
          }
          case "initiate_call": {
            const handle = optionalString(raw.handle);
            if (!handle) {
              throw new Error("handle is required");
            }
            const status = await runtime.status();
            if (!status.helperConnected) {
              throw new Error("FaceTime helper is not connected");
            }
            if (status.driverInstallPending) {
              throw new Error("FaceTime audio driver installation is pending");
            }
            if (status.calls.length > 0 || status.outboundCallPending) {
              throw new Error("another FaceTime call is active or pending");
            }
            const mode = raw.mode === "audio" || raw.mode === "video" ? raw.mode : undefined;
            const result = await runtime.dial({
              handle,
              mode,
            });
            const { helper: _helper, ...publicResult } = result;
            return json({ ok: true, action, ...publicResult });
          }
          case "end_call": {
            const result = await runtime.hangup({
              callUUID: optionalString(raw.callUUID),
            });
            return json({ ok: true, action, ...result });
          }
          default:
            throw new Error(
              "action must be get_status, check_readiness, initiate_call, or end_call",
            );
        }
      } catch (error) {
        return json({
          ok: false,
          action,
          error: formatErrorMessage(error),
        });
      }
    },
  };
}

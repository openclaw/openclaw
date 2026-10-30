import type { NativeHookRelayProcessResponse } from "./native-hook-relay-types.js";

function renderJsonResponse(payload: object): NativeHookRelayProcessResponse {
  return { stdout: `${JSON.stringify(payload)}\n`, stderr: "", exitCode: 0 };
}

/** Render the native Codex hook responses shared by server and cold client paths. */
export const codexNativeHookRelayResponseCodec = {
  renderNoopResponse(): NativeHookRelayProcessResponse {
    // Codex treats empty stdout plus exit 0 as no decision/no additional context.
    return { stdout: "", stderr: "", exitCode: 0 };
  },
  renderPreToolUseBlockResponse(
    reason: string,
    failureDisposition?: NativeHookRelayProcessResponse["failureDisposition"],
  ): NativeHookRelayProcessResponse {
    return {
      ...renderJsonResponse({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: reason,
        },
      }),
      ...(failureDisposition ? { failureDisposition } : {}),
    };
  },
  renderPermissionDecisionResponse(
    decision: "allow" | "deny",
    message?: string,
  ): NativeHookRelayProcessResponse {
    return renderJsonResponse({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision:
          decision === "allow"
            ? { behavior: "allow" }
            : {
                behavior: "deny",
                message: message?.trim() || "Denied by OpenClaw",
              },
      },
    });
  },
  renderBeforeAgentFinalizeReviseResponse: (reason: string) =>
    renderJsonResponse({ decision: "block", reason }),
  renderBeforeAgentFinalizeStopResponse: (reason?: string) =>
    renderJsonResponse({
      continue: false,
      ...(reason?.trim() ? { stopReason: reason.trim() } : {}),
    }),
};

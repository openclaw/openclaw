import type {
  PermissionHandler,
  PermissionRequest as SdkPermissionRequest,
  PermissionRequestResult as SdkPermissionRequestResult,
} from "@github/copilot-sdk";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";

interface CopilotPermissionContext {
  sessionId: string;
  request: SdkPermissionRequest;
}

/** Undefined decisions fail closed, as do policy errors. */
export type CopilotPermissionPolicy = (
  ctx: CopilotPermissionContext,
) => SdkPermissionRequestResult | undefined | Promise<SdkPermissionRequestResult | undefined>;

const REJECT_ALL_FEEDBACK =
  "copilot agent runtime: no permission policy installed (fail-closed default)";

export const rejectAllPolicy: CopilotPermissionPolicy = () => ({
  kind: "reject",
  feedback: REJECT_ALL_FEEDBACK,
});

export function createPermissionBridge(
  policy: CopilotPermissionPolicy = rejectAllPolicy,
): PermissionHandler {
  return async (request, invocation) => {
    const ctx: CopilotPermissionContext = {
      request,
      sessionId: invocation.sessionId,
    };
    try {
      const result = await policy(ctx);
      if (result !== undefined) {
        return result;
      }
    } catch (error) {
      return {
        kind: "reject",
        feedback: `copilot permission policy threw: ${formatErrorMessage(error)}`,
      };
    }
    return { kind: "reject", feedback: REJECT_ALL_FEEDBACK };
  };
}

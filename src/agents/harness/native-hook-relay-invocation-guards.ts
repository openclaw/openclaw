import { createSubsystemLogger } from "../../logging/subsystem.js";
import { MAX_NATIVE_HOOK_RELAY_INVOCATIONS } from "./native-hook-relay-state.js";
import type {
  ActiveNativeHookRelayRegistration,
  InvokeNativeHookRelayParams,
  NativeHookRelayEvent,
  NativeHookRelayRegistration,
} from "./native-hook-relay-types.js";
import { isJsonObject } from "./native-hook-relay-utils.js";

const log = createSubsystemLogger("harness/native-hook-relay");

export function isNativeHookRelayReadinessProbe(params: {
  params: InvokeNativeHookRelayParams;
  registration: ActiveNativeHookRelayRegistration;
  event: NativeHookRelayEvent;
}): boolean {
  if (
    params.event !== "pre_tool_use" ||
    params.params.readinessNonce !== params.registration.readinessNonce ||
    !isJsonObject(params.params.rawPayload)
  ) {
    return false;
  }
  const payload = params.params.rawPayload;
  if (
    payload.hook_event_name !== "PreToolUse" ||
    payload.tool_name !== "Bash" ||
    typeof payload.tool_use_id !== "string" ||
    !payload.tool_use_id.startsWith("openclaw-relay-readiness-") ||
    !isJsonObject(payload.tool_input)
  ) {
    return false;
  }
  return payload.tool_input.command === "/bin/echo ok";
}

export function projectNativeHookRelayPreToolUseFailure(
  registration: ActiveNativeHookRelayRegistration,
  failure: Parameters<NonNullable<NativeHookRelayRegistration["onPreToolUseFailure"]>>[0],
): void {
  const callback = registration.onPreToolUseFailure;
  if (!callback || registration.preToolUseFailureProjections.has(failure.toolCallId)) {
    return;
  }
  const record = {
    promise: Promise.resolve().then(() => callback(failure)),
    settled: false,
  };
  registration.preToolUseFailureProjections.set(failure.toolCallId, record);
  void record.promise.then(
    () => {
      record.settled = true;
    },
    (error: unknown) => {
      record.settled = true;
      if (registration.preToolUseFailureProjections.get(failure.toolCallId) === record) {
        registration.preToolUseFailureProjections.delete(failure.toolCallId);
      }
      log.debug("native pre-tool failure projection failed", {
        error,
        relayId: registration.relayId,
        toolCallId: failure.toolCallId,
      });
    },
  );
  if (registration.preToolUseFailureProjections.size > MAX_NATIVE_HOOK_RELAY_INVOCATIONS) {
    let oldestToolCallId: string | undefined;
    for (const [toolCallId, candidate] of registration.preToolUseFailureProjections) {
      oldestToolCallId ??= toolCallId;
      if (candidate.settled) {
        registration.preToolUseFailureProjections.delete(toolCallId);
        return;
      }
    }
    if (oldestToolCallId) {
      registration.preToolUseFailureProjections.delete(oldestToolCallId);
    }
  }
}

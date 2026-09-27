import { nativeHookRelayTesting } from "openclaw/plugin-sdk/agent-harness-runtime";

/** Capture an action report before a deliberately delayed fixture callback. */
export function captureNativeFailureReporter(relayId: string, toolCallId: string) {
  const relay = nativeHookRelayTesting.getNativeHookRelayRegistrationForTests(relayId);
  const report = relay?.bindToolExecution?.({ toolName: "exec", toolCallId });
  if (!report || !relay?.onPreToolUseFailure) {
    throw new Error("expected bound native side reporter");
  }
  return (failure: Parameters<NonNullable<typeof relay.onPreToolUseFailure>>[0]) =>
    relay.onPreToolUseFailure?.({ ...failure, report });
}

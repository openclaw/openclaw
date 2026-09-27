import { randomUUID } from "node:crypto";
import { ADMIN_SCOPE } from "../../gateway/operator-scopes.js";
import { callGatewayTool } from "../tools/gateway.js";
import {
  invokeNativeHookRelayBridge,
  isNativeHookRelayBridgeStaleRegistrationError,
} from "./native-hook-relay-client.js";
import type {
  InvokeNativeHookRelayParams,
  NativeHookRelayProcessResponse,
  NativeHookRelayProvider,
} from "./native-hook-relay-types.js";

class NativeHookRelayReadinessResponseError extends Error {}

export async function verifyNativeHookRelayPreToolUseReadiness(params: {
  provider: NativeHookRelayProvider;
  relayId: string;
  generation: string;
  readinessNonce: string;
  sessionId: string;
  nativeThreadId?: string;
  turnId: string;
  recover: () => Promise<void>;
  invokeBridge?: typeof invokeNativeHookRelayBridge;
  invokeGateway?: (params: InvokeNativeHookRelayParams) => Promise<NativeHookRelayProcessResponse>;
}): Promise<void> {
  const invokeBridge = params.invokeBridge ?? invokeNativeHookRelayBridge;
  const invokeGateway =
    params.invokeGateway ??
    ((invokeParams: InvokeNativeHookRelayParams) =>
      callGatewayTool<NativeHookRelayProcessResponse>(
        "nativeHook.invoke",
        { timeoutMs: 2_000 },
        invokeParams,
        { scopes: [ADMIN_SCOPE] },
      ));
  const rawPayload = {
    hook_event_name: "PreToolUse",
    session_id: params.nativeThreadId?.trim() || params.sessionId,
    turn_id: params.turnId,
    tool_name: "Bash",
    tool_use_id: `openclaw-relay-readiness-${randomUUID()}`,
    tool_input: { command: "/bin/echo ok" },
  };
  const invocation = {
    provider: params.provider,
    relayId: params.relayId,
    generation: params.generation,
    readinessNonce: params.readinessNonce,
    event: "pre_tool_use",
    rawPayload,
  } satisfies InvokeNativeHookRelayParams;
  const assertServiced = (response: NativeHookRelayProcessResponse) => {
    if (
      response.exitCode !== 0 ||
      response.stderr.trim().length > 0 ||
      response.failureDisposition !== undefined
    ) {
      throw new NativeHookRelayReadinessResponseError(
        "native hook relay readiness probe returned a hook failure",
      );
    }
  };
  const invokeProbe = async () => {
    const response = await invokeBridge({
      ...invocation,
      timeoutMs: 2_000,
      registrationTimeoutMs: 250,
    });
    assertServiced(response);
  };
  try {
    await invokeProbe();
  } catch (error) {
    if (
      error instanceof NativeHookRelayReadinessResponseError ||
      isNativeHookRelayBridgeStaleRegistrationError(error)
    ) {
      throw error;
    }
    try {
      await params.recover();
      await invokeProbe();
    } catch (retryError) {
      if (
        retryError instanceof NativeHookRelayReadinessResponseError ||
        isNativeHookRelayBridgeStaleRegistrationError(retryError)
      ) {
        throw retryError;
      }
      try {
        assertServiced(await invokeGateway(invocation));
      } catch (gatewayError) {
        const directMessage = retryError instanceof Error ? retryError.message : String(retryError);
        const gatewayMessage =
          gatewayError instanceof Error ? gatewayError.message : String(gatewayError);
        throw new Error(
          `native hook relay readiness failed (direct bridge and gateway fallback): direct=${directMessage}; gateway=${gatewayMessage}`,
          { cause: gatewayError },
        );
      }
    }
  }
}

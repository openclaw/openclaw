import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { loadMcpToolGrants } from "../../infra/exec-approvals-mcp.js";
import { resolveProjectedMcpCodexToolApprovalMode } from "../mcp-codex-tool-approval.js";
import { drainNativeHookRelayBridge } from "./native-hook-relay-bridge.js";
import { NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR } from "./native-hook-relay-client.js";
import type {
  ActiveNativeHookRelayRegistration,
  NativeHookRelayBridgeRegistration,
  NativeHookRelayRegistration,
  RegisterNativeHookRelayParams,
  RelayLifetime,
} from "./native-hook-relay-contexts.js";
import { nativeHookRelayState } from "./native-hook-relay-state.js";
import type { NativeHookRelayEvent } from "./native-hook-relay-types.js";
import { isJsonObject } from "./native-hook-relay-utils.js";

const { relays } = nativeHookRelayState;

/** Capture synchronous inputs before the relay owner admits its deferred policy read. */
export function prepareNativeHookRelayMcpPolicy(
  params: Pick<
    RegisterNativeHookRelayParams,
    "agentId" | "autoApproveMcpTools" | "config" | "projectedMcpServers"
  >,
  stateDbPath: string,
  isCurrent: () => boolean,
): Promise<boolean | undefined> {
  const agentId = params.agentId;
  const autoApproveMcpTools = params.autoApproveMcpTools === true;
  const configuredMcpToolApprovals = Object.keys({
    ...params.projectedMcpServers,
    ...params.config?.mcp?.servers,
  }).some(
    (serverName) =>
      resolveProjectedMcpCodexToolApprovalMode(
        serverName,
        params.config?.mcp?.servers?.[serverName] ?? {},
        params.projectedMcpServers?.[serverName],
      ) !== undefined,
  );
  return Promise.resolve().then(async () => {
    if (!isCurrent()) {
      return undefined;
    }
    // Native names lose raw identity; Codex applies its prepared per-tool approval config.
    return (
      autoApproveMcpTools ||
      (agentId ? (await loadMcpToolGrants(agentId, { path: stateDbPath })).length > 0 : false) ||
      configuredMcpToolApprovals
    );
  });
}

/** Preserve the first failure while joining work admitted during a pending drain. */
export async function drainNativeHookRelayWork(params: {
  policyReady: Promise<void>;
  bridge: NativeHookRelayBridgeRegistration;
  readRenewal: () => Promise<void>;
  postToolUseWork: Set<Promise<void>>;
}): Promise<void> {
  let renewal: Promise<void>;
  let failure: { error: unknown } | undefined;
  await params.policyReady.catch((error: unknown) => {
    failure = { error };
  });
  do {
    renewal = params.readRenewal();
    try {
      await renewal;
    } catch (error) {
      failure ??= { error };
    }
    const observations = [...params.postToolUseWork];
    const results = await Promise.allSettled(observations);
    for (const [index, result] of results.entries()) {
      params.postToolUseWork.delete(observations[index]!);
      if (result.status === "rejected") {
        failure ??= { error: result.reason };
      }
    }
    try {
      await drainNativeHookRelayBridge(params.bridge);
    } catch (error) {
      failure ??= { error };
    }
  } while (renewal !== params.readRenewal() || params.postToolUseWork.size > 0);
  if (failure) {
    throw failure.error;
  }
}

function assertNativeHookRelayRegistrationCurrent(
  registration: ActiveNativeHookRelayRegistration,
): void {
  if (relays.get(registration.relayId) !== registration || Date.now() > registration.expiresAtMs) {
    throw new Error("native hook relay registration is inactive");
  }
}

export function assertNativeHookRelayForegroundCurrent(
  registration: ActiveNativeHookRelayRegistration,
  lifetime: Pick<RelayLifetime, "foregroundOpen">,
): void {
  assertNativeHookRelayRegistrationCurrent(registration);
  registration.signal?.throwIfAborted();
  registration.assertActive?.();
  if (!lifetime.foregroundOpen) {
    throw new Error("native hook relay foreground invocation not allowed");
  }
}

export async function resolveNativeHookRelayInvocationBinding(
  registration: ActiveNativeHookRelayRegistration,
  lifetime: RelayLifetime | undefined,
  event: NativeHookRelayEvent,
  rawPayload: unknown,
  signal?: AbortSignal,
): Promise<{
  registration: NativeHookRelayRegistration;
  assertExecutionAdmissionCurrent: () => void;
}> {
  if (!lifetime) {
    throw new Error("native hook relay registration is inactive");
  }
  // Gateway fallback shares policy readiness without depending on HTTP locator publication.
  await racePromiseWithAbortSignal(lifetime.policyReady, signal);
  signal?.throwIfAborted();
  assertNativeHookRelayRegistrationCurrent(registration);
  const claim = lifetime.retention?.readClaim(rawPayload);
  if (claim && event === "pre_tool_use" && lifetime.retained && lifetime.retention) {
    const retained = lifetime.retained;
    const retention = lifetime.retention;
    let assertAdmission: (() => boolean) | undefined;
    const assertRetainedAuthority = () => {
      assertNativeHookRelayRegistrationCurrent(registration);
      registration.signal?.throwIfAborted();
      retained.assertActive();
      if (assertAdmission && !assertAdmission()) {
        throw new Error("native hook relay retained invocation not allowed");
      }
      if (!retention.allowPreToolUse(claim)) {
        throw new Error("native hook relay retained invocation not allowed");
      }
    };
    const assertActive = () => {
      signal?.throwIfAborted();
      assertRetainedAuthority();
    };
    if (!lifetime.foregroundOpen && !retention.allowPreToolUse(claim)) {
      throw new Error("native hook relay retained invocation not allowed");
    }
    if (retention.awaitForegroundAdmission) {
      assertAdmission = await racePromiseWithAbortSignal(
        retention.awaitForegroundAdmission(claim, signal),
        signal,
      );
      if (!assertAdmission) {
        throw new Error("native hook relay retained invocation not allowed");
      }
      assertActive();
    } else if (!retention.allowPreToolUse(claim)) {
      throw new Error("native hook relay retained invocation not allowed");
    }
    return {
      registration: {
        ...registration,
        assertActive,
        // Retained child custody replaces the foreground execution policy owner.
        assertActiveAsync: undefined,
        runBeforeToolCall: retained.runBeforeToolCall,
        signal,
      },
      assertExecutionAdmissionCurrent: assertRetainedAuthority,
    };
  }
  if (!lifetime.foregroundOpen) {
    throw new Error("native hook relay foreground invocation not allowed");
  }
  const foregroundTurn = lifetime.foregroundTurn;
  const assertExecutionAdmissionCurrent = () => {
    assertNativeHookRelayForegroundCurrent(registration, lifetime);
    // Stable hook commands can discover a successor's token. Only the accepted
    // native turn or a separately admitted child belongs to this run.
    if (
      foregroundTurn !== undefined &&
      !(claim && lifetime.retention?.allowPreToolUse(claim)) &&
      (!foregroundTurn ||
        lifetime.foregroundTurn !== foregroundTurn ||
        !isJsonObject(rawPayload) ||
        rawPayload.session_id !== foregroundTurn.threadId ||
        rawPayload.turn_id !== foregroundTurn.turnId)
    ) {
      throw new Error(NATIVE_HOOK_RELAY_BRIDGE_STALE_REGISTRATION_ERROR);
    }
  };
  if (foregroundTurn !== undefined) {
    assertExecutionAdmissionCurrent();
  }
  const assertActive = () => {
    signal?.throwIfAborted();
    assertExecutionAdmissionCurrent();
  };
  return {
    registration: { ...registration, assertActive, signal },
    assertExecutionAdmissionCurrent,
  };
}

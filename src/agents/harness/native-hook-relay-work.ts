import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { loadMcpToolGrants } from "../../infra/exec-approvals-mcp.js";
import { resolveProjectedMcpCodexToolApprovalMode } from "../mcp-codex-tool-approval.js";
import { drainNativeHookRelayBridge } from "./native-hook-relay-bridge.js";
import { nativeHookRelayState } from "./native-hook-relay-state.js";
import type {
  ActiveNativeHookRelayRegistration,
  NativeHookRelayBridgeRegistration,
  NativeHookRelayEvent,
  NativeHookRelayRegistration,
  RegisterNativeHookRelayParams,
  RelayLifetime,
} from "./native-hook-relay-types.js";

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
    try {
      await drainNativeHookRelayBridge(params.bridge);
    } catch (error) {
      failure ??= { error };
    }
  } while (renewal !== params.readRenewal());
  if (failure) {
    throw failure.error;
  }
}

export function assertNativeHookRelayForegroundCurrent(
  registration: ActiveNativeHookRelayRegistration,
  lifetime: { foregroundOpen: boolean; foregroundToken: symbol },
  foregroundToken: symbol,
): void {
  if (relays.get(registration.relayId) !== registration || Date.now() > registration.expiresAtMs) {
    throw new Error("native hook relay registration is inactive");
  }
  registration.signal?.throwIfAborted();
  registration.assertActive?.();
  if (!lifetime.foregroundOpen || lifetime.foregroundToken !== foregroundToken) {
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
  if (relays.get(registration.relayId) !== registration || Date.now() > registration.expiresAtMs) {
    throw new Error("native hook relay registration is inactive");
  }
  const claim = lifetime.retention?.readClaim(rawPayload);
  if (claim && event === "pre_tool_use" && lifetime.retained && lifetime.retention) {
    const retained = lifetime.retained;
    const retention = lifetime.retention;
    let assertAdmission: (() => boolean) | undefined;
    const assertRetainedAuthority = () => {
      if (
        relays.get(registration.relayId) !== registration ||
        Date.now() > registration.expiresAtMs
      ) {
        throw new Error("native hook relay registration is inactive");
      }
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
        runBeforeToolCall: retained.runBeforeToolCall,
        signal,
      },
      assertExecutionAdmissionCurrent: assertRetainedAuthority,
    };
  }
  if (!lifetime.foregroundOpen) {
    throw new Error("native hook relay foreground invocation not allowed");
  }
  const foregroundToken = lifetime.foregroundToken;
  const assertExecutionAdmissionCurrent = () =>
    assertNativeHookRelayForegroundCurrent(registration, lifetime, foregroundToken);
  const assertActive = () => {
    signal?.throwIfAborted();
    assertExecutionAdmissionCurrent();
  };
  return {
    registration: { ...registration, assertActive, signal },
    assertExecutionAdmissionCurrent,
  };
}

import { loadMcpToolGrants } from "../../infra/exec-approvals-mcp.js";
import { resolveProjectedMcpCodexToolApprovalMode } from "../mcp-codex-tool-approval.js";
import { drainNativeHookRelayBridge } from "./native-hook-relay-bridge.js";
import { nativeHookRelayState } from "./native-hook-relay-state.js";
import type {
  ActiveNativeHookRelayRegistration,
  NativeHookRelayBridgeRegistration,
  RegisterNativeHookRelayParams,
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

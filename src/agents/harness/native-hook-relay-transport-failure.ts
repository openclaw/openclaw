/** Relay-transport failure accounting shared by the bridge and the relay entrypoint. */
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  normalizeNativeHookToolName,
  readNativeHookRelayApprovalMode,
} from "./native-hook-relay-codec.js";
import type {
  ActiveNativeHookRelayRegistration,
  NativeHookRelayRegistration,
} from "./native-hook-relay-contexts.js";
import {
  MAX_NATIVE_HOOK_RELAY_INVOCATIONS,
  nativeHookRelayState,
} from "./native-hook-relay-state.js";
import type {
  NativeHookRelayEvent,
  NativeHookRelayInvocation,
  NativeHookRelayProcessResponse,
  NativeHookRelayTransportFailureCause,
} from "./native-hook-relay-types.js";

const log = createSubsystemLogger("agents/harness/native-hook-relay");

const { pendingPermissionApprovals, relays } = nativeHookRelayState;

/**
 * Whether a relay is still parked inside an approval it asked a human for.
 *
 * Only `permission_request` blocks a relay invocation on a person, and it does so
 * for DEFAULT_PERMISSION_TIMEOUT_MS — far longer than any transport ceiling. The
 * pre-tool-use deferred approvals are handed to the app-server and resolved by a
 * later call, so they are not an in-flight wait and deliberately do not appear here.
 *
 * The scope is the relay, not the tool call: the pending entry is keyed by the
 * approval's own content fingerprint, and an entry lives only until the decision,
 * its expiry, or relay teardown. A concurrent sibling call therefore delays a
 * genuine terminal verdict by at most one approval, and never suppresses it.
 */
export function isNativeHookRelayAwaitingApproval(relayId: string): boolean {
  for (const approval of pendingPermissionApprovals.values()) {
    if (approval.relayId === relayId) {
      return true;
    }
  }
  return false;
}

/**
 * Consecutive relay-transport failures tolerated before the relay refuses every
 * further invocation with an explicit error.
 *
 * One failure is expected and recoverable: a stable-id replacement keeps the
 * previous locator for NATIVE_HOOK_BRIDGE_REPLACEMENT_RECORD_GRACE_MS and the
 * client retries through it, so a single lost race is normal. Two can still fall
 * inside one rotation window when it straddles two hooks. Three consecutive
 * failures with no intervening success cannot be explained by a rotation race —
 * at the default relay timeout that is a transport unusable for >=15s, during
 * which every hook has already fail-closed denied a tool call, so the child is
 * making no progress either way.
 */
const NATIVE_HOOK_RELAY_TRANSPORT_FAILURE_THRESHOLD = 3;

/**
 * Server-side ceiling on one bridge invocation, independent of the client budget.
 *
 * This bounds a parent that stopped making progress, so it is deliberately short.
 * An invocation parked on a human approval is still making progress and re-arms
 * the ceiling instead of tripping it; see isNativeHookRelayAwaitingApproval.
 * A relay registered with a longer command budget uses that budget instead.
 */
export const NATIVE_HOOK_RELAY_BRIDGE_INVOCATION_DEADLINE_MS = 30_000;

/**
 * Whether a bridge-observed timeout landed on an invocation that is waiting for a person.
 *
 * `client-disconnected` and `server-deadline` are the two causes the parent can
 * raise while it is still serving the invocation. A relay parked in an approval
 * outlives both budgets by design — Codex's hookTimeoutSec has no upper bound and
 * the approval itself is allowed DEFAULT_PERMISSION_TIMEOUT_MS — so counting that
 * wait toward the consecutive-failure streak would latch a healthy relay terminal
 * after three slow approvals. The transport is demonstrably alive: the parent is
 * the side holding the prompt open.
 */
function isNativeHookRelayApprovalWaitFailure(params: {
  relayId: string;
  cause: NativeHookRelayTransportFailureCause;
}): boolean {
  if (params.cause !== "client-disconnected" && params.cause !== "server-deadline") {
    return false;
  }
  return isNativeHookRelayAwaitingApproval(params.relayId);
}

/**
 * Whether this invocation's transport failure decides the tool call's fate.
 *
 * A `permission_request` the child abandons is not a failed tool call. The child
 * treats a missing hook decision as "no decision" and falls through to its own
 * native approval path (see runNativeHookRelayPermissionRequest's closing noop),
 * so the person may still approve there and the tool then runs normally. Telling
 * the run owner the call timed out would be a claim about an outcome the parent
 * never observed — and the projection wins over the real terminal event, so a
 * call that actually succeeded would still be reported as failed.
 *
 * A `post_tool_use` the child abandons is not a failed tool call either, for the
 * stronger reason: the call already ran, and Codex's PostToolUse outcome cannot
 * block, delay, or mutate it. The child's own fail-closed path agrees — only
 * `pre_tool_use` and `permission_request` render a deny when the relay is
 * unreachable (renderNativeHookRelayUnavailableResponse); `post_tool_use` renders
 * the noop. So no reading of an abandoned post-tool-use hook makes "this tool
 * call failed" true, while the projection still outranks the real terminal event.
 *
 * Every other event keeps projecting. `pre_tool_use` in particular must: when the
 * child abandons that hook it manufactures its own fail-closed deny, so the tool
 * call genuinely did not run and the run owner has to hear about it.
 *
 * `before_agent_finalize` is deliberately absent. It carries no tool call — the
 * Stop payload has no tool and nothing on that path reads toolUseId — so the
 * caller's own `params.toolCallId` guard already suppresses it, and naming it
 * here would add a branch no regression could hold.
 *
 * An unreadable event is treated as projectable, which is the pre-existing
 * behavior. It cannot mask an approval in practice: the bridge parses the event
 * before it parses the payload the tool call id comes from, so a request that
 * produced a tool call id always produced its event too.
 *
 * Both projection sites consult this. The bridge records a transport failure for
 * an invocation that never produced a response, and the relay entrypoint projects
 * for the same invocation when the bridge's abort unwinds it; whichever lands
 * first wins the per-tool-call dedupe, so gating only one leaves the bug intact.
 */
function transportFailureDecidesToolCallFate(event: NativeHookRelayEvent | undefined): boolean {
  return event !== "permission_request" && event !== "post_tool_use";
}

export type NativeHookRelayTransportFailureState = {
  consecutive: number;
  terminal?: {
    cause: NativeHookRelayTransportFailureCause;
    consecutive: number;
    atMs: number;
  };
};

function readTransportFailureState(
  registration: ActiveNativeHookRelayRegistration,
): NativeHookRelayTransportFailureState {
  registration.relayTransportFailures ??= { consecutive: 0 };
  return registration.relayTransportFailures;
}

/** Map a transport cause onto the closed diagnostic disposition union. */
export function nativeHookRelayTransportFailureDisposition(
  cause: NativeHookRelayTransportFailureCause,
): "timed_out" | "failed" {
  return cause === "client-disconnected" || cause === "server-deadline" || cause === "relay-timeout"
    ? "timed_out"
    : "failed";
}

/**
 * Record one relay-transport failure the parent observed directly.
 *
 * The fail-closed deny a child manufactures for itself never reaches the parent,
 * so this is the only place the parent learns a child hook was attempted and
 * abandoned. Crossing the threshold latches a terminal state that makes every
 * later invocation on the relay throw, which is what turns a silent
 * normal-looking completion into an explicit error result.
 */
export function recordNativeHookRelayTransportFailure(params: {
  relayId: string;
  cause: NativeHookRelayTransportFailureCause;
  event?: NativeHookRelayEvent;
  elapsedMs?: number;
  toolName?: string;
  toolCallId?: string;
}): NativeHookRelayTransportFailureState | undefined {
  const registration = relays.get(params.relayId);
  if (!registration) {
    return undefined;
  }
  const state = readTransportFailureState(registration);
  const disposition = nativeHookRelayTransportFailureDisposition(params.cause);
  const approvalWait = isNativeHookRelayApprovalWaitFailure({
    relayId: params.relayId,
    cause: params.cause,
  });
  if (!approvalWait) {
    state.consecutive += 1;
  }
  log.warn(
    approvalWait
      ? "native hook relay approval wait outlived its transport budget"
      : "native hook relay transport failure",
    {
      relayId: params.relayId,
      runId: registration.runId,
      sessionId: registration.sessionId,
      cause: params.cause,
      disposition,
      ...(params.event ? { event: params.event } : {}),
      ...(typeof params.elapsedMs === "number" ? { elapsedMs: params.elapsedMs } : {}),
      consecutiveFailures: state.consecutive,
      threshold: NATIVE_HOOK_RELAY_TRANSPORT_FAILURE_THRESHOLD,
    },
  );
  // An excused wait still tells the run owner when the tool call itself failed
  // closed for the child; only the relay's own health verdict is withheld. An
  // abandoned approval or post-tool-use hook decides nothing about the call.
  if (params.toolCallId && transportFailureDecidesToolCallFate(params.event)) {
    projectNativeHookRelayPreToolUseFailure(registration, {
      toolName: params.toolName ?? "",
      toolCallId: params.toolCallId,
      disposition,
      durationMs: params.elapsedMs ?? 0,
    });
  }
  // An excused wait left `consecutive` alone, so it cannot reach the threshold here.
  if (state.consecutive >= NATIVE_HOOK_RELAY_TRANSPORT_FAILURE_THRESHOLD && !state.terminal) {
    state.terminal = {
      cause: params.cause,
      consecutive: state.consecutive,
      atMs: Date.now(),
    };
    log.error("native hook relay transport failed", {
      relayId: params.relayId,
      runId: registration.runId,
      sessionId: registration.sessionId,
      cause: params.cause,
      consecutiveFailures: state.consecutive,
      threshold: NATIVE_HOOK_RELAY_TRANSPORT_FAILURE_THRESHOLD,
    });
  }
  return state;
}

/** Clear the consecutive counter after a relay invocation completed end to end. */
export function resetNativeHookRelayTransportFailures(
  registration: ActiveNativeHookRelayRegistration,
): void {
  const state = registration.relayTransportFailures;
  if (!state || state.terminal || state.consecutive === 0) {
    return;
  }
  state.consecutive = 0;
}

/** Read the latched terminal transport state, if the relay has one. */
export function readNativeHookRelayTransportFailureTerminal(
  registration: ActiveNativeHookRelayRegistration,
): NativeHookRelayTransportFailureState["terminal"] {
  return registration.relayTransportFailures?.terminal;
}

/**
 * Hand one pre-tool-use failure to the run owner exactly once per tool call.
 *
 * Lives here rather than in the relay entrypoint so the bridge can project a
 * failure for an invocation that never produced a response.
 */
function projectNativeHookRelayPreToolUseFailure(
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

/** Bind one invocation’s failure projection before awaiting policy or transport work. */
export function createNativeHookRelayPreToolUseFailureProjector(
  registration: ActiveNativeHookRelayRegistration,
  normalized: NativeHookRelayInvocation,
  startedAt: number,
): (disposition: NonNullable<NativeHookRelayProcessResponse["failureDisposition"]>) => void {
  // Neither a permission_request nor a post_tool_use response ever carries a
  // failureDisposition — only renderPreToolUseBlockResponse takes one — so the
  // event test bites on exactly the transport-abort path the entrypoint shares
  // with the bridge.
  const shouldProjectFailure =
    Boolean(normalized.toolUseId) &&
    transportFailureDecidesToolCallFate(normalized.event) &&
    readNativeHookRelayApprovalMode(normalized.rawPayload) !== "report";
  return (disposition: NonNullable<NativeHookRelayProcessResponse["failureDisposition"]>) => {
    if (!shouldProjectFailure || !normalized.toolUseId) {
      return;
    }
    projectNativeHookRelayPreToolUseFailure(registration, {
      toolName: normalizeNativeHookToolName(normalized.toolName),
      toolCallId: normalized.toolUseId,
      disposition,
      durationMs: Date.now() - startedAt,
    });
  };
}

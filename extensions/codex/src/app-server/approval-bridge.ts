import {
  type AgentApprovalEventData,
  type BeforeToolCallFailureDisposition,
  type ExecApprovalDecision,
  formatApprovalDisplayPath,
  hasNativeHookRelayInvocation,
  invokeNativeHookRelay,
  resolveNativeHookRelayDeferredToolApproval,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
  type NativeHookRelayProcessResponse,
  type NativeHookRelayRegistrationHandle,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  normalizeTrimmedStringList,
  readStringField as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { safeParseJson, sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { formatCodexDisplayText } from "../command-formatters.js";
import {
  commandApprovalAllowedDecisions,
  commandApprovalCapabilities,
  resolveCommandApproval,
} from "./native-command-approval.js";
import {
  approvalRequestExplicitlyUnavailable,
  codexApprovalTimeoutText,
  mapExecDecisionToOutcome,
  requestPluginApproval,
  sanitizeCodexApprovalVisibleText,
  stripDanglingCodexApprovalTerminalSequence,
  truncateCodexApprovalDisplayText as truncate,
  type AppServerApprovalOutcome,
  type CodexApprovalKind,
  waitForPluginApprovalDecision,
} from "./plugin-approval-roundtrip.js";
import { isJsonObject, type JsonObject, type JsonValue } from "./protocol.js";
import { CodexServerRequestResolvedError } from "./server-requests.js";
import { resolveCodexToolAbortTerminalReason } from "./tool-abort-terminal-reason.js";

const PERMISSION_DESCRIPTION_MAX_LENGTH = 700;
const PERMISSION_SAMPLE_LIMIT = 2;
const PERMISSION_VALUE_MAX_LENGTH = 48;
const COMMAND_PREVIEW_WITH_DETAILS_MAX_LENGTH = 80;
const APPROVAL_PREVIEW_SCAN_MAX_LENGTH = 4096;
const APPROVAL_PREVIEW_OMITTED = "[preview truncated or unsafe content omitted]";
// Automatic approval is limited to concrete calls. A before_tool_call allow
// covers the evaluated call, not future scope; new or grant-shaped methods stay human-gated.
const CONCRETE_TOOL_AUTO_APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);

type ApprovalPreviewSource = {
  value: string;
  clipped: boolean;
};

type SanitizedApprovalPreview = {
  text?: string;
  omitted: boolean;
};

type ApprovalNativeHookRelay = Pick<
  NativeHookRelayRegistrationHandle,
  "allowedEvents" | "generation" | "relayId"
>;

export async function handleCodexAppServerApprovalRequest(params: {
  method: string;
  requestParams: JsonValue | undefined;
  paramsForRun: EmbeddedRunAttemptParams;
  threadId: string;
  turnId: string;
  nativeHookRelay?: ApprovalNativeHookRelay;
  autoApprove?: boolean;
  signal?: AbortSignal;
  onNativeToolFailureDisposition?: (
    itemId: string,
    disposition: Exclude<BeforeToolCallFailureDisposition, "blocked">,
    approvalKind?: CodexApprovalKind,
  ) => void;
}): Promise<JsonValue | undefined> {
  const requestParams = isJsonObject(params.requestParams) ? params.requestParams : undefined;
  if (
    readString(requestParams, "threadId") !== params.threadId ||
    readString(requestParams, "turnId") !== params.turnId
  ) {
    return undefined;
  }
  const context = buildApprovalContext({
    method: params.method,
    requestParams,
  });
  const emitEvent = (data: Omit<AgentApprovalEventData, "kind" | "title">) => {
    void params.paramsForRun.onAgentEvent?.({
      stream: "approval",
      data: {
        kind: context.kind,
        title: context.title,
        ...context.eventDetails,
        ...data,
      },
    });
  };
  const finishApproval = (
    outcome: AppServerApprovalOutcome,
    { message, ...details }: Omit<AgentApprovalEventData, "kind" | "title" | "phase">,
  ): JsonValue => {
    emitEvent({
      phase: "resolved",
      ...details,
      ...approvalEventScope(params.method, outcome),
      message,
    });
    return buildApprovalResponse(params.method, context.requestParams, outcome);
  };
  if (params.signal?.aborted) {
    if (params.signal.reason instanceof CodexServerRequestResolvedError) {
      return undefined;
    }
    recordNativeToolFailureDisposition(params, context, "cancelled");
    return buildApprovalResponse(params.method, context.requestParams, "cancelled");
  }
  let revalidateMutableFileApproval:
    | (() => Promise<{ ok: true } | { ok: false; message: string }>)
    | undefined;
  let mutableFileApprovalRequiresOneShot = false;
  let approvalId: string | undefined;
  const resolvePolicyApproval = async (
    outcome: Extract<AppServerApprovalOutcome, "denied" | "approved-once" | "approved-session">,
    message = approvalResolutionMessage(outcome),
    resolvedApprovalId?: string,
  ): Promise<JsonValue> => {
    let resolvedOutcome = outcome;
    let resolvedMessage = message;
    // This is the last enforceable client boundary before Codex owns spawn.
    // Releasing without this check would approve bytes changed during the wait.
    if (outcome !== "denied" && revalidateMutableFileApproval) {
      const binding = await revalidateMutableFileApproval();
      if (!binding.ok) {
        resolvedOutcome = "denied";
        resolvedMessage = binding.message;
      }
    }
    if (resolvedOutcome === "approved-session" && mutableFileApprovalRequiresOneShot) {
      resolvedOutcome = "approved-once";
      resolvedMessage = "Codex app-server approval granted for this byte-bound command only.";
    }
    if (params.method === "item/commandExecution/requestApproval" && resolvedOutcome !== "denied") {
      const resolution = resolveCommandApproval(context.requestParams, resolvedOutcome);
      if (resolution.scope === "denied") {
        resolvedOutcome = "denied";
        resolvedMessage = "Codex app-server request does not offer the approved scope.";
      } else if (resolvedOutcome === "approved-session" && resolution.scope === "once") {
        resolvedOutcome = "approved-once";
        resolvedMessage = approvalResolutionMessage(resolvedOutcome);
      } else if (resolution.scope === "persistent") {
        resolvedMessage =
          "Codex app-server approval granted; persistent policy amendment requested for future sessions.";
      }
    }
    // Permission changes close this native turn while its outer run stays live.
    // Recheck after byte revalidation before releasing a grant to Codex.
    params.signal?.throwIfAborted();
    if (resolvedOutcome !== "denied") {
      params.paramsForRun.hostCapabilities.assertActive();
    }
    return finishApproval(resolvedOutcome, {
      status: resolvedOutcome === "denied" ? "denied" : "approved",
      ...(resolvedApprovalId
        ? { approvalId: resolvedApprovalId, approvalSlug: resolvedApprovalId }
        : {}),
      message: resolvedMessage,
    });
  };
  try {
    if (
      params.method === "item/commandExecution/requestApproval" &&
      !readNetworkApprovalContext(requestParams)
    ) {
      const command = readPolicyCommand(requestParams);
      const cwd = readString(requestParams, "cwd") ?? params.paramsForRun.workspaceDir;
      // Snapshot the executable file operands before policy or operator waits;
      // an unbound or unreadable script could otherwise change under the prompt.
      const prepareMutableFileApproval =
        params.paramsForRun.hostCapabilities.prepareMutableFileApproval;
      if (!prepareMutableFileApproval) {
        return await resolvePolicyApproval(
          "denied",
          "SYSTEM_RUN_DENIED: mutable file approval binding is unavailable",
        );
      }
      const prepared = await prepareMutableFileApproval({
        command: command ?? "",
        cwd,
      });
      if (!prepared.ok) {
        return await resolvePolicyApproval("denied", prepared.message);
      }
      mutableFileApprovalRequiresOneShot = prepared.requiresOneShot;
      revalidateMutableFileApproval = prepared.revalidate;
    }
    const policyOutcome = await runOpenClawToolPolicyForApprovalRequest({
      method: params.method,
      requestParams,
      paramsForRun: params.paramsForRun,
      context,
      nativeHookRelay: params.nativeHookRelay,
      autoApprove: params.autoApprove,
      signal: params.signal,
    });
    params.signal?.throwIfAborted();
    if (policyOutcome?.outcome === "denied") {
      recordNativeToolFailureDisposition(params, context, policyOutcome.failureDisposition);
      return await resolvePolicyApproval("denied", policyOutcome.reason);
    }
    if (policyOutcome?.outcome === "approved-once") {
      return await resolvePolicyApproval(policyOutcome.outcome);
    }
    const canAutoApproveConcreteToolCall =
      CONCRETE_TOOL_AUTO_APPROVAL_METHODS.has(params.method) &&
      !readNetworkApprovalContext(requestParams);
    if (canAutoApproveConcreteToolCall && params.autoApprove === true) {
      return await resolvePolicyApproval(
        "approved-once",
        "Codex app-server approval auto-approved by runtime policy.",
      );
    }
    // Codex app-server approval requests do not expose an enforceable resolved
    // executable, so unresolved requests must stay on the human approval route.
    const allowedDecisions = nativeApprovalAllowedDecisions({
      method: params.method,
      requestParams,
      requiresOneShot: mutableFileApprovalRequiresOneShot,
    });
    const repeatedApproval =
      params.method === "item/commandExecution/requestApproval" &&
      allowedDecisions?.includes("allow-always")
        ? commandApprovalCapabilities(requestParams).repeated
        : undefined;
    const requestResult = await requestPluginApproval({
      hostCapabilities: params.paramsForRun.hostCapabilities,
      signal: params.signal,
      title: context.title,
      description:
        repeatedApproval?.scope === "persistent"
          ? `${repeatedApproval.description}\n${context.description}`
          : context.description,
      severity: context.severity,
      toolName: context.toolName,
      toolCallId: context.approvalId,
      allowedDecisions,
    });
    approvalId = requestResult?.id;
    params.signal?.throwIfAborted();
    if (!approvalId) {
      recordNativeToolFailureDisposition(params, context, "failed");
      return finishApproval("denied", {
        status: "unavailable",
        message: "Codex app-server approval route unavailable.",
      });
    }

    emitEvent({
      phase: "requested",
      status: "pending",
      approvalId,
      approvalSlug: approvalId,
      message: "Codex app-server approval requested.",
    });

    const requestUnavailable = approvalRequestExplicitlyUnavailable(requestResult);
    const approvalResult = requestUnavailable
      ? undefined
      : await waitForPluginApprovalDecision({
          approvalId,
          signal: params.signal,
          hostCapabilities: params.paramsForRun.hostCapabilities,
        });
    params.signal?.throwIfAborted();
    const approvalTimedOut = approvalResult?.terminalReason === "timeout";
    const outcome = mapExecDecisionToOutcome(approvalResult?.decision);
    if (approvalTimedOut) {
      recordNativeToolFailureDisposition(params, context, "timed_out", context.approvalKind);
    } else if (outcome === "unavailable") {
      recordNativeToolFailureDisposition(params, context, "failed");
    }

    if (outcome === "approved-once" || outcome === "approved-session") {
      return await resolvePolicyApproval(outcome, approvalResolutionMessage(outcome), approvalId);
    }

    return finishApproval(outcome, {
      status: outcome,
      approvalId,
      approvalSlug: approvalId,
      message: approvalTimedOut
        ? codexApprovalTimeoutText(context.approvalKind)
        : approvalResolutionMessage(outcome),
    });
  } catch (error) {
    if (params.signal?.reason instanceof CodexServerRequestResolvedError) {
      return undefined;
    }
    const cancelled = params.signal?.aborted === true;
    recordNativeToolFailureDisposition(
      params,
      context,
      cancelled && params.signal ? resolveCodexToolAbortTerminalReason(params.signal) : "failed",
    );
    return finishApproval(cancelled ? "cancelled" : "denied", {
      status: cancelled ? "failed" : "unavailable",
      ...(approvalId ? { approvalId, approvalSlug: approvalId } : {}),
      message: cancelled
        ? "Codex app-server approval cancelled because the run stopped."
        : `Codex app-server approval route failed: ${formatCodexDisplayText(
            coerceErrorMessage(error),
          )}`,
    });
  }
}

function recordNativeToolFailureDisposition(
  params: Pick<
    Parameters<typeof handleCodexAppServerApprovalRequest>[0],
    "onNativeToolFailureDisposition" | "signal"
  >,
  context: Pick<ApprovalContext, "itemId">,
  disposition: Exclude<BeforeToolCallFailureDisposition, "blocked"> | undefined,
  approvalKind?: CodexApprovalKind,
): void {
  if (!context.itemId || !disposition) {
    return;
  }
  try {
    const resolvedDisposition = params.signal?.aborted
      ? resolveCodexToolAbortTerminalReason(params.signal)
      : disposition;
    params.onNativeToolFailureDisposition?.(
      context.itemId,
      resolvedDisposition,
      ...(resolvedDisposition === "timed_out" && approvalKind ? [approvalKind] : []),
    );
  } catch {
    // Audit projection must not alter the approval decision sent to Codex.
  }
}

function buildApprovalResponse(
  method: string,
  requestParams: JsonObject | undefined,
  outcome: AppServerApprovalOutcome,
): JsonValue {
  if (method === "item/commandExecution/requestApproval") {
    return { decision: resolveCommandApproval(requestParams, outcome).decision };
  }
  if (method === "item/fileChange/requestApproval") {
    return {
      decision: {
        cancelled: "cancel",
        denied: "decline",
        unavailable: "decline",
        "approved-session": "acceptForSession",
        "approved-once": "accept",
      }[outcome],
    };
  }
  if (method === "item/permissions/requestApproval") {
    if (outcome === "approved-session" || outcome === "approved-once") {
      return {
        permissions: requestedPermissions(requestParams),
        scope: outcome === "approved-session" ? "session" : "turn",
      };
    }
    return { permissions: {}, scope: "turn" };
  }
  return {
    decision: "decline",
    reason: "OpenClaw codex app-server bridge does not grant native approvals yet.",
  };
}

function buildApprovalContext(params: { method: string; requestParams: JsonObject | undefined }) {
  const itemId =
    readString(params.requestParams, "itemId") ??
    readString(params.requestParams, "callId") ??
    readString(params.requestParams, "approvalId");
  // Codex gives every execve callback its own approvalId while retaining the
  // parent itemId. Policy and relay dedupe must use the callback identity.
  const approvalId = readString(params.requestParams, "approvalId") ?? itemId;
  const commandDetailLines =
    params.method === "item/commandExecution/requestApproval"
      ? describeCommandApprovalDetails(params.requestParams)
      : [];
  const commandPreview = sanitizeApprovalPreview(
    readJoinedPreview(readCommandActions(params.requestParams), " && ") ??
      readCommandPreview(params.requestParams),
    commandDetailLines.length > 0 ? COMMAND_PREVIEW_WITH_DETAILS_MAX_LENGTH : 180,
  );
  const reasonPreview = sanitizeApprovalPreview(
    readStringPreview(params.requestParams, "reason"),
    180,
  );
  const command = commandPreview.text;
  const reason = reasonPreview.text;
  const networkApproval =
    params.method === "item/commandExecution/requestApproval"
      ? readNetworkApprovalContext(params.requestParams)
      : undefined;
  const approvalKind: CodexApprovalKind = params.method.includes("commandExecution")
    ? "command"
    : params.method.includes("fileChange")
      ? "file-change"
      : params.method.includes("permissions")
        ? "permissions"
        : "other";
  const kind: AgentApprovalEventData["kind"] =
    approvalKind === "command" ? "exec" : approvalKind === "other" ? "unknown" : "plugin";
  const permissionLines =
    params.method === "item/permissions/requestApproval"
      ? describePermissionProfile(requestedPermissions(params.requestParams), "Permissions")
      : [];
  const approvalType = networkApproval
    ? "network"
    : kind === "exec"
      ? "command"
      : params.method === "item/permissions/requestApproval"
        ? "permission"
        : kind === "plugin"
          ? "file"
          : undefined;
  const title = `Codex app-server ${approvalType ? `${approvalType} ` : ""}approval`;
  const subject =
    (networkApproval
      ? `Network: ${sanitizeCodexApprovalVisibleText(networkApproval.protocol)}://${sanitizePermissionHostValue(networkApproval.host)}`
      : undefined) ??
    permissionLines[0] ??
    (command
      ? `Command: ${formatApprovalPreviewSubject(command, commandPreview.omitted)}`
      : commandPreview.omitted
        ? `Command: ${APPROVAL_PREVIEW_OMITTED}`
        : reason
          ? `Reason: ${formatApprovalPreviewSubject(reason, reasonPreview.omitted)}`
          : reasonPreview.omitted
            ? `Reason: ${APPROVAL_PREVIEW_OMITTED}`
            : `Request method: ${params.method}`);
  const description =
    permissionLines.length > 0
      ? joinDescriptionLinesWithinLimit(permissionLines, PERMISSION_DESCRIPTION_MAX_LENGTH)
      : [subject, ...commandDetailLines].join("\n");
  return {
    approvalKind,
    kind,
    title,
    description,
    severity: kind === "exec" ? ("warning" as const) : ("info" as const),
    toolName: `codex_${approvalType ?? "file"}_approval`,
    itemId,
    approvalId,
    requestParams: params.requestParams,
    eventDetails: {
      ...(itemId ? { itemId } : {}),
      ...(command ? { command } : {}),
      ...(commandPreview.omitted ? { commandPreviewOmitted: true } : {}),
      ...(reason ? { reason } : {}),
      ...(reasonPreview.omitted ? { reasonPreviewOmitted: true } : {}),
    },
  };
}

type ApprovalContext = ReturnType<typeof buildApprovalContext>;
type ApprovalPolicyOutcome =
  | {
      outcome: "denied";
      reason: string;
      failureDisposition?: Exclude<BeforeToolCallFailureDisposition, "blocked">;
    }
  | { outcome: "approved-once" }
  | { outcome: "allowed" };

async function runOpenClawToolPolicyForApprovalRequest(params: {
  method: string;
  requestParams: JsonObject | undefined;
  paramsForRun: EmbeddedRunAttemptParams;
  context: ApprovalContext;
  nativeHookRelay?: ApprovalNativeHookRelay;
  autoApprove?: boolean;
  signal?: AbortSignal;
}): Promise<ApprovalPolicyOutcome | undefined> {
  const policyRequest = buildOpenClawToolPolicyRequest(params.method, params.requestParams);
  if (!policyRequest) {
    return undefined;
  }
  const cwd = readString(params.requestParams, "cwd") ?? params.paramsForRun.workspaceDir;
  const assertActive = params.paramsForRun.hostCapabilities.assertActive;
  const nativeRelayOutcome = await runNativeRelayPolicy(policyRequest.params);
  if (nativeRelayOutcome) {
    return nativeRelayOutcome;
  }
  const outcome = await params.paramsForRun.hostCapabilities.runBeforeToolCall({
    toolName: policyRequest.toolName,
    params: policyRequest.params,
    ...(cwd ? { nativeOperation: { cwd } } : {}),
    ...(params.context.approvalId ? { toolCallId: params.context.approvalId } : {}),
    signal: params.signal,
  });
  if (outcome.blocked) {
    return {
      outcome: "denied",
      reason: outcome.reason,
      ...(outcome.kind === "failure" && outcome.disposition !== "blocked"
        ? { failureDisposition: outcome.disposition }
        : {}),
    };
  }
  if ("params" in outcome && toolPolicyParamsWereRewritten(policyRequest.params, outcome.params)) {
    return {
      outcome: "denied",
      reason:
        "OpenClaw tool policy rewrote Codex app-server approval params; refusing original request.",
    };
  }
  if (outcome.approvalResolution) {
    return {
      // Generic plugin approval `allow-always` is plugin-owned durability, not
      // Codex session trust. Keep the app-server request scoped to this item.
      outcome: "approved-once",
    };
  }
  return { outcome: "allowed" };

  async function runNativeRelayPolicy(
    toolParams: JsonObject,
  ): Promise<ApprovalPolicyOutcome | undefined> {
    const nativeHookRelay = params.nativeHookRelay;
    // Only command approvals correspond to Codex PreToolUse execution. File-change
    // and permission approvals stay on the app-server approval route below.
    if (
      params.method !== "item/commandExecution/requestApproval" ||
      !nativeHookRelay?.allowedEvents.includes("pre_tool_use")
    ) {
      return undefined;
    }
    const command = readString(toolParams, "command");
    if (!command) {
      return undefined;
    }
    const turnId = readString(params.requestParams, "turnId");
    const payload: JsonObject = {
      hook_event_name: "PreToolUse",
      openclaw_approval_mode: "report",
      tool_name: "exec_command",
      ...(params.context.approvalId ? { tool_use_id: params.context.approvalId } : {}),
      ...(cwd ? { cwd } : {}),
      ...(turnId ? { turn_id: turnId } : {}),
      tool_input: { ...toolParams, command, cmd: command },
    };
    const resolveDeferredApproval = async (): Promise<ApprovalPolicyOutcome> => {
      const approvalOutcome = await resolveNativeHookRelayDeferredToolApproval({
        relayId: nativeHookRelay.relayId,
        toolUseId: params.context.approvalId,
        signal: params.signal,
      });
      assertActive();
      if (approvalOutcome?.outcome === "denied") {
        return {
          outcome: "denied",
          reason: approvalOutcome.reason,
          ...(approvalOutcome.failureDisposition
            ? { failureDisposition: approvalOutcome.failureDisposition }
            : {}),
        };
      }
      return approvalOutcome?.outcome === "approved-once"
        ? { outcome: approvalOutcome.outcome }
        : { outcome: "allowed" };
    };
    if (
      hasNativeHookRelayInvocation({
        relayId: nativeHookRelay.relayId,
        event: "pre_tool_use",
        toolUseId: params.context.approvalId,
      })
    ) {
      return resolveDeferredApproval();
    }
    try {
      const response = await invokeNativeHookRelay({
        provider: "codex",
        relayId: nativeHookRelay.relayId,
        generation: nativeHookRelay.generation,
        event: "pre_tool_use",
        rawPayload: payload,
        requireGeneration: true,
      });
      const denial = readNativeRelayPreToolUseDenial(response);
      if (denial) {
        return denial;
      }
      return await resolveDeferredApproval();
    } catch (error) {
      // Only a relay that failed before invocation is unavailable. Once invoked,
      // handler failures join explicit denials and malformed replies in failing closed.
      if (
        params.autoApprove === true &&
        !hasNativeHookRelayInvocation({
          relayId: nativeHookRelay.relayId,
          event: "pre_tool_use",
          toolUseId: params.context.approvalId,
        })
      ) {
        return undefined;
      }
      return {
        outcome: "denied",
        reason: `OpenClaw native hook relay unavailable for Codex app-server approval: ${formatCodexDisplayText(
          coerceErrorMessage(error),
        )}`,
        failureDisposition: "failed",
      };
    }
  }
}

function readNativeRelayPreToolUseDenial(
  response: NativeHookRelayProcessResponse | undefined,
): Extract<ApprovalPolicyOutcome, { outcome: "denied" }> | undefined {
  if (!response || response.exitCode !== 0) {
    return {
      outcome: "denied",
      reason:
        sanitizeRelayDecisionReason(response?.stderr) ||
        sanitizeRelayDecisionReason(response?.stdout) ||
        "OpenClaw native hook relay failed for Codex app-server approval.",
      failureDisposition: response?.failureDisposition ?? "failed",
    };
  }
  const stdout = response.stdout?.trim();
  if (!stdout) {
    return undefined;
  }
  const parsed = safeParseJson<unknown>(stdout);
  const output =
    isJsonObject(parsed) && isJsonObject(parsed.hookSpecificOutput)
      ? parsed.hookSpecificOutput
      : undefined;
  if (output?.permissionDecision === "deny") {
    return {
      outcome: "denied",
      reason:
        readString(output, "permissionDecisionReason") ||
        "OpenClaw native hook policy denied Codex app-server approval.",
      ...(response.failureDisposition ? { failureDisposition: response.failureDisposition } : {}),
    };
  }
  // The app-server bridge invokes the relay in report mode, where the relay
  // contract is deny-or-silent. Any other structured decision fails closed.
  return {
    outcome: "denied",
    reason: output
      ? "OpenClaw native hook relay returned a non-deny Codex app-server approval decision."
      : "OpenClaw native hook relay returned an unreadable Codex app-server approval result.",
    failureDisposition: "failed",
  };
}

function sanitizeRelayDecisionReason(value: string | undefined): string | undefined {
  const preview = sanitizeApprovalPreview(value ? { value, clipped: false } : undefined, 240);
  return preview.text;
}

function buildOpenClawToolPolicyRequest(
  method: string,
  requestParams: JsonObject | undefined,
): { toolName: string; params: JsonObject } | undefined {
  if (method === "item/commandExecution/requestApproval") {
    if (readNetworkApprovalContext(requestParams)) {
      return {
        toolName: "codex_network_approval",
        params: { approval: requestParams ?? {} },
      };
    }
    const command = readPolicyCommand(requestParams);
    return {
      toolName: "exec",
      params: {
        ...(command ? { command } : {}),
        ...(readString(requestParams, "cwd") ? { cwd: readString(requestParams, "cwd") } : {}),
        approval: requestParams ?? {},
      },
    };
  }
  if (method === "item/fileChange/requestApproval") {
    return { toolName: "apply_patch", params: requestParams ?? {} };
  }
  if (method === "item/permissions/requestApproval") {
    return { toolName: "codex_permission_approval", params: requestParams ?? {} };
  }
  return undefined;
}

function toolPolicyParamsWereRewritten(original: JsonObject, candidate: unknown): boolean {
  if (candidate === original) {
    return false;
  }
  const originalText = stableJsonText(original);
  const candidateText = stableJsonText(candidate);
  return !candidateText || candidateText !== originalText;
}

function stableJsonText(value: unknown): string | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => stableJsonText(item));
    return items.every((item): item is string => item !== undefined)
      ? `[${items.join(",")}]`
      : undefined;
  }
  if (isJsonObject(value)) {
    const entries = Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => {
        const text = stableJsonText(item);
        return text === undefined ? undefined : `${JSON.stringify(key)}:${text}`;
      });
    return entries.every((entry): entry is string => entry !== undefined)
      ? `{${entries.join(",")}}`
      : undefined;
  }
  return undefined;
}

function nativeApprovalAllowedDecisions(params: {
  method: string;
  requestParams: JsonObject | undefined;
  requiresOneShot: boolean;
}): ExecApprovalDecision[] | undefined {
  if (params.method === "item/fileChange/requestApproval") {
    return ["allow-once", "allow-always", "deny"];
  }
  return params.method === "item/commandExecution/requestApproval"
    ? commandApprovalAllowedDecisions(params.requestParams, params.requiresOneShot)
    : undefined;
}

function requestedPermissions(requestParams: JsonObject | undefined): JsonObject {
  const permissions = isJsonObject(requestParams?.permissions) ? requestParams.permissions : {};
  const granted: JsonObject = {};
  if (isJsonObject(permissions.network)) {
    granted.network = permissions.network;
  }
  if (isJsonObject(permissions.fileSystem)) {
    granted.fileSystem = permissions.fileSystem;
  }
  return granted;
}

function describeCommandApprovalDetails(requestParams: JsonObject | undefined): string[] {
  const additionalPermissions = isJsonObject(requestParams?.additionalPermissions)
    ? requestParams.additionalPermissions
    : undefined;
  return [
    ...(additionalPermissions
      ? describePermissionProfile(additionalPermissions, "Additional permissions")
      : []),
    summarizeExecPolicyAmendment(requestParams?.proposedExecpolicyAmendment),
    summarizePermissionTargets(requestParams?.proposedNetworkPolicyAmendments, { kind: "network" }),
  ].filter((line): line is string => Boolean(line));
}

function describePermissionProfile(permissions: JsonObject, label: string): string[] {
  const lines: string[] = [];
  const risks = new Set<string>();
  const kinds = ["network", "fileSystem"].filter((kind) => isJsonObject(permissions[kind]));
  if (kinds.length > 0) {
    lines.push(`${label}: ${kinds.join(", ")}`);
  }
  let networkSummary: string | undefined;
  if (isJsonObject(permissions.network)) {
    const summaries = [
      summarizeNetworkEnabledPermission(permissions.network, risks),
      summarizePermissionArray(permissions.network.allowHosts, "allowHosts", risks, {
        sanitize: sanitizePermissionHostValue,
        risksFor: permissionHostRisks,
      }),
    ].filter((summary): summary is string => Boolean(summary));
    networkSummary = summaries.length > 0 ? summaries.join("; ") : undefined;
  }
  let fileSystemSummary: string | undefined;
  const fileSystem = permissions.fileSystem;
  if (isJsonObject(fileSystem)) {
    const summaries = [
      ...["read", "write", "roots", "readPaths", "writePaths"].map((key) =>
        summarizePermissionArray(fileSystem[key], key, risks, {
          sanitize: sanitizePermissionPathValue,
          risksFor: permissionPathRisks,
        }),
      ),
      summarizePermissionTargets(fileSystem.entries, { kind: "file-system", risks }),
    ].filter((summary): summary is string => Boolean(summary));
    fileSystemSummary = summaries.length > 0 ? summaries.join("; ") : undefined;
  }
  if (risks.size > 0) {
    lines.push(`High-risk targets: ${[...risks].join(", ")}`);
  }
  if (networkSummary) {
    lines.push(`Network ${networkSummary}`);
  }
  if (fileSystemSummary) {
    lines.push(`File system ${fileSystemSummary}`);
  }
  return lines;
}

function summarizeNetworkEnabledPermission(
  permission: JsonObject,
  risks: Set<string>,
): string | undefined {
  const enabled = permission.enabled;
  if (typeof enabled !== "boolean") {
    return undefined;
  }
  if (enabled) {
    risks.add("network access");
  }
  return `enabled: ${enabled}`;
}

function summarizePermissionTargets(
  entries: JsonValue | undefined,
  format: { kind: "file-system"; risks: Set<string> } | { kind: "network" },
): string | undefined {
  if (!Array.isArray(entries)) {
    return undefined;
  }
  const fileSystem = format.kind === "file-system";
  const sanitizeTarget = fileSystem ? sanitizePermissionPathValue : sanitizePermissionHostValue;
  const samples: string[] = [];
  let count = 0;
  for (const entry of entries) {
    const item = isJsonObject(entry) ? entry : undefined;
    const rawTarget = item?.[fileSystem ? "path" : "host"];
    const rawAction = item?.[fileSystem ? "access" : "action"];
    const target = typeof rawTarget === "string" ? (fileSystem ? rawTarget.trim() : rawTarget) : "";
    const action = typeof rawAction === "string" ? (fileSystem ? rawAction.trim() : rawAction) : "";
    if (!target || !action) {
      continue;
    }
    count += 1;
    if (format.kind === "file-system" && action !== "none") {
      for (const risk of permissionPathRisks(target)) {
        format.risks.add(risk);
      }
    }
    if (samples.length < PERMISSION_SAMPLE_LIMIT) {
      samples.push(`${sanitizeCodexApprovalVisibleText(action)} ${sanitizeTarget(target)}`);
    }
  }
  return formatPermissionSamples(
    fileSystem ? "entries" : "Proposed network policy",
    samples,
    count,
  );
}

function summarizePermissionArray(
  input: JsonValue | undefined,
  label: string,
  risks: Set<string>,
  format: {
    sanitize: (value: string) => string;
    risksFor: (value: string) => readonly string[];
  },
): string | undefined {
  const values = normalizeTrimmedStringList(input);
  if (values.length === 0) {
    return undefined;
  }
  for (const value of values) {
    for (const risk of format.risksFor(value)) {
      risks.add(risk);
    }
  }
  const sampleValues = values
    .slice(0, PERMISSION_SAMPLE_LIMIT)
    .map(format.sanitize)
    .filter(Boolean);
  return formatPermissionSamples(label, sampleValues, values.length);
}

function summarizeExecPolicyAmendment(value: JsonValue | undefined): string | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => sanitizeCodexApprovalVisibleText(entry))
    .filter(Boolean);
  return formatPermissionSamples(
    "Proposed exec policy",
    values.slice(0, PERMISSION_SAMPLE_LIMIT),
    values.length,
  );
}

function formatPermissionSamples(
  label: string,
  samples: string[],
  count: number,
): string | undefined {
  if (count === 0) {
    return undefined;
  }
  if (samples.length === 0) {
    return `${label}: ${count}`;
  }
  const remaining = count - samples.length;
  const remainderSuffix = remaining > 0 ? ` (+${remaining} more)` : "";
  return `${label}: ${samples.join(", ")}${remainderSuffix}`;
}

function sanitizePermissionHostValue(value: string): string {
  const compact = sanitizeCodexApprovalVisibleText(value).toLowerCase();
  const withoutScheme = compact.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const authority = withoutScheme.split(/[/?#]/, 1)[0] ?? withoutScheme;
  const withoutUserInfo = authority.includes("@")
    ? authority.slice(authority.lastIndexOf("@") + 1)
    : authority;
  return truncate(withoutUserInfo, PERMISSION_VALUE_MAX_LENGTH);
}

function sanitizePermissionPathValue(value: string): string {
  return truncate(
    formatApprovalDisplayPath(sanitizeCodexApprovalVisibleText(value)),
    PERMISSION_VALUE_MAX_LENGTH,
  );
}

function permissionHostRisks(value: string): string[] {
  const normalized = value.trim().toLowerCase();
  if (!normalized.includes("*")) {
    return [];
  }
  return isPrivateNetworkHostPattern(normalized)
    ? ["wildcard hosts", "private-network wildcards"]
    : ["wildcard hosts"];
}

function permissionPathRisks(value: string): string[] {
  const normalized = sanitizeCodexApprovalVisibleText(value);
  return normalized === "/" || normalized === "\\" || /^[A-Za-z]:[\\/]*$/.test(normalized)
    ? ["filesystem root"]
    : [];
}

function isPrivateNetworkHostPattern(value: string): boolean {
  const normalized = value.toLowerCase();
  const wildcardStripped = normalized.replace(/^\*\./, "");
  if (
    wildcardStripped === "localhost" ||
    ["local", "internal", "lan", "home", "corp", "private"].some(
      (suffix) => wildcardStripped === suffix || wildcardStripped.endsWith(`.${suffix}`),
    )
  ) {
    return true;
  }
  return (
    ["10.", "127.", "192.168.", "169.254."].some((prefix) => wildcardStripped.startsWith(prefix)) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(wildcardStripped)
  );
}

function approvalResolutionMessage(outcome: AppServerApprovalOutcome): string {
  return {
    "approved-session": "Codex app-server approval granted for the session.",
    "approved-once": "Codex app-server approval granted for this turn.",
    cancelled: "Codex app-server approval cancelled.",
    unavailable: "Codex app-server approval unavailable.",
    denied: "Codex app-server approval denied.",
  }[outcome];
}

function approvalEventScope(
  method: string,
  outcome: AppServerApprovalOutcome,
): Pick<AgentApprovalEventData, "scope"> {
  return method === "item/permissions/requestApproval"
    ? { scope: outcome === "approved-session" ? "session" : "turn" }
    : {};
}

function readPolicyCommand(record: JsonObject | undefined): string | undefined {
  const command = record?.command;
  if (typeof command === "string") {
    return command;
  }
  if (Array.isArray(command) && command.every((part): part is string => typeof part === "string")) {
    return command.join(" ");
  }
  const actionCommands = readCommandActions(record);
  if (actionCommands.length > 0) {
    return actionCommands.join(" && ");
  }
  return undefined;
}

function readNetworkApprovalContext(
  record: JsonObject | undefined,
): { host: string; protocol: string } | undefined {
  const context = isJsonObject(record?.networkApprovalContext)
    ? record.networkApprovalContext
    : undefined;
  const host = readString(context, "host");
  const protocol = readString(context, "protocol");
  return host && protocol ? { host, protocol } : undefined;
}

function readCommandActions(record: JsonObject | undefined): string[] {
  const actions = record?.commandActions;
  if (!Array.isArray(actions)) {
    return [];
  }
  return actions
    .map((action) => (isJsonObject(action) ? readString(action, "command") : undefined))
    .filter((command): command is string => Boolean(command));
}

function readCommandPreview(record: JsonObject | undefined): ApprovalPreviewSource | undefined {
  const command = record?.command;
  if (typeof command === "string") {
    return previewSource(command);
  }
  if (!Array.isArray(command)) {
    return undefined;
  }
  return readJoinedPreview(command, " ");
}

function readJoinedPreview(
  parts: JsonValue[],
  separator: string,
): ApprovalPreviewSource | undefined {
  let source: ApprovalPreviewSource | undefined;
  for (const part of parts) {
    if (typeof part !== "string") {
      return undefined;
    }
    const prefix = source?.value ? `${source.value}${separator}` : "";
    source = previewSource(`${prefix}${part}`);
    if (source.clipped) {
      break;
    }
  }
  return source;
}

function readStringPreview(
  record: JsonObject | undefined,
  key: string,
): ApprovalPreviewSource | undefined {
  const value = readString(record, key);
  return value === undefined ? undefined : previewSource(value);
}

function previewSource(value: string): ApprovalPreviewSource {
  return {
    value: sliceUtf16Safe(value, 0, APPROVAL_PREVIEW_SCAN_MAX_LENGTH),
    clipped: value.length > APPROVAL_PREVIEW_SCAN_MAX_LENGTH,
  };
}

function sanitizeApprovalPreview(
  source: ApprovalPreviewSource | undefined,
  maxLength: number,
): SanitizedApprovalPreview {
  if (!source || !source.value) {
    return { omitted: false };
  }
  const rawPreview = stripDanglingCodexApprovalTerminalSequence(source.value);
  const sanitized = sanitizeCodexApprovalVisibleText(rawPreview);
  if (!sanitized) {
    return { omitted: true };
  }
  return { text: formatCodexDisplayText(truncate(sanitized, maxLength)), omitted: source.clipped };
}

function formatApprovalPreviewSubject(text: string, omitted: boolean): string {
  return omitted ? `${text} ${APPROVAL_PREVIEW_OMITTED}` : text;
}

function joinDescriptionLinesWithinLimit(lines: string[], maxLength: number): string {
  let description = "";
  for (const line of lines) {
    const prefix = description ? "\n" : "";
    const next = `${description}${prefix}${line}`;
    if (next.length <= maxLength) {
      description = next;
      continue;
    }
    const remaining = maxLength - description.length - prefix.length;
    if (remaining < 3) {
      break;
    }
    description += `${prefix}${truncate(line, remaining)}`;
    break;
  }
  return description;
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

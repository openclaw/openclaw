import type { ToolLoopDetectionConfig } from "../config/types.tools.js";
import type { SessionState } from "../logging/diagnostic-session-state.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { copyPluginToolMeta } from "../plugins/tools.js";
import { PluginApprovalResolutions, type PluginApprovalResolution } from "../plugins/types.js";
import { createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import { isPlainObject } from "../utils.js";
import { copyChannelAgentToolMeta } from "./channel-tools.js";
import {
  checkAcceptEditsConstraint,
  extractApplyPatchTargetPaths,
} from "./plan-mode/accept-edits-gate.js";
import { checkMutationGate, type PlanMode } from "./plan-mode/index.js";
import { normalizeToolName } from "./tool-policy.js";
import type { AnyAgentTool } from "./tools/common.js";
import { callGatewayTool } from "./tools/gateway.js";

export type HookContext = {
  agentId?: string;
  sessionKey?: string;
  /** Ephemeral session UUID — regenerated on /new and /reset. */
  sessionId?: string;
  runId?: string;
  loopDetection?: ToolLoopDetectionConfig;
  /**
   * Current plan-mode session state (PR-8). When `"plan"`, the runtime
   * mutation gate (src/agents/plan-mode/mutation-gate.ts) blocks
   * write/edit/exec/etc. before the plugin hookRunner runs. The runner
   * (pi-tools.ts) reads `SessionEntry.planMode.mode` once per run-setup
   * and threads it through here so this hook doesn't have to load the
   * session store on every tool call.
   */
  planMode?: PlanMode;
  /**
   * Bug 3+4 fix: live-read accessor for the session's current planMode.
   * Returns the LATEST mode from the in-memory SessionEntry on every
   * call (O(1) map lookup, no disk I/O), bypassing the stale
   * `planMode` snapshot captured at run-start. Used by the mutation
   * gate below to handle mid-turn approval transitions where the
   * cached `planMode` is stale (sessions.patch flipped mode → "normal"
   * but the runtime still has "plan" cached for the rest of the
   * current run).
   *
   * Returning `undefined` is fine — caller falls back to the cached
   * `planMode` snapshot. Optional so test contexts and unit fixtures
   * don't have to provide it.
   */
  getLatestPlanMode?: () => PlanMode | undefined;
  /**
   * Live-read accessor for the session's `postApprovalPermissions.
   * acceptEdits` flag. Returns `true` only when the user explicitly
   * approved the plan with the "Accept, allow edits" button; `false`
   * otherwise (including disk-read failures — fail-closed on the
   * permission read, fail-open on the subsequent gate).
   *
   * When `true`, the acceptEdits constraint gate
   * (src/agents/plan-mode/accept-edits-gate.ts) runs in normal-mode
   * tool calls and blocks the three hard-constraint categories
   * (destructive, self-restart, config-change).
   *
   * Optional so test contexts and unit fixtures don't have to
   * provide it. When absent, the acceptEdits gate is not invoked.
   */
  getLatestAcceptEdits?: () => boolean;
};

type HookOutcome = { blocked: true; reason: string } | { blocked: false; params: unknown };

const log = createSubsystemLogger("agents/tools");
const BEFORE_TOOL_CALL_WRAPPED = Symbol("beforeToolCallWrapped");
const BEFORE_TOOL_CALL_HOOK_FAILURE_REASON =
  "Tool call blocked because before_tool_call hook failed";
const adjustedParamsByToolCallId = new Map<string, unknown>();
const MAX_TRACKED_ADJUSTED_PARAMS = 1024;
const LOOP_WARNING_BUCKET_SIZE = 10;
const MAX_LOOP_WARNING_KEYS = 256;

const loadBeforeToolCallRuntime = createLazyRuntimeSurface(
  () => import("./pi-tools.before-tool-call.runtime.js"),
  ({ beforeToolCallRuntime }) => beforeToolCallRuntime,
);

function buildAdjustedParamsKey(params: { runId?: string; toolCallId: string }): string {
  if (params.runId && params.runId.trim()) {
    return `${params.runId}:${params.toolCallId}`;
  }
  return params.toolCallId;
}

function mergeParamsWithApprovalOverrides(
  originalParams: unknown,
  approvalParams?: unknown,
): unknown {
  if (approvalParams && isPlainObject(approvalParams)) {
    if (isPlainObject(originalParams)) {
      return { ...originalParams, ...approvalParams };
    }
    return approvalParams;
  }
  return originalParams;
}

function isAbortSignalCancellation(err: unknown, signal?: AbortSignal): boolean {
  if (!signal?.aborted) {
    return false;
  }
  if (err === signal.reason) {
    return true;
  }
  if (err instanceof Error && err.name === "AbortError") {
    return true;
  }
  return false;
}

function unwrapErrorCause(err: unknown): unknown {
  if (err instanceof Error && err.cause !== undefined) {
    return err.cause;
  }
  return err;
}

function shouldEmitLoopWarning(state: SessionState, warningKey: string, count: number): boolean {
  if (!state.toolLoopWarningBuckets) {
    state.toolLoopWarningBuckets = new Map();
  }
  const bucket = Math.floor(count / LOOP_WARNING_BUCKET_SIZE);
  const lastBucket = state.toolLoopWarningBuckets.get(warningKey) ?? 0;
  if (bucket <= lastBucket) {
    return false;
  }
  state.toolLoopWarningBuckets.set(warningKey, bucket);
  if (state.toolLoopWarningBuckets.size > MAX_LOOP_WARNING_KEYS) {
    const oldest = state.toolLoopWarningBuckets.keys().next().value;
    if (oldest) {
      state.toolLoopWarningBuckets.delete(oldest);
    }
  }
  return true;
}

async function recordLoopOutcome(args: {
  ctx?: HookContext;
  toolName: string;
  toolParams: unknown;
  toolCallId?: string;
  result?: unknown;
  error?: unknown;
}): Promise<void> {
  if (!args.ctx?.sessionKey) {
    return;
  }
  try {
    const { getDiagnosticSessionState, recordToolCallOutcome } = await loadBeforeToolCallRuntime();
    const sessionState = getDiagnosticSessionState({
      sessionKey: args.ctx.sessionKey,
      sessionId: args.ctx?.agentId,
    });
    recordToolCallOutcome(sessionState, {
      toolName: args.toolName,
      toolParams: args.toolParams,
      toolCallId: args.toolCallId,
      result: args.result,
      error: args.error,
      config: args.ctx.loopDetection,
    });
  } catch (err) {
    log.warn(`tool loop outcome tracking failed: tool=${args.toolName} error=${String(err)}`);
  }
}

export async function runBeforeToolCallHook(args: {
  toolName: string;
  params: unknown;
  toolCallId?: string;
  ctx?: HookContext;
  signal?: AbortSignal;
}): Promise<HookOutcome> {
  const toolName = normalizeToolName(args.toolName || "tool");
  const params = args.params;

  if (args.ctx?.sessionKey) {
    const { getDiagnosticSessionState, logToolLoopAction, detectToolCallLoop, recordToolCall } =
      await loadBeforeToolCallRuntime();
    const sessionState = getDiagnosticSessionState({
      sessionKey: args.ctx.sessionKey,
      sessionId: args.ctx?.agentId,
    });

    const loopResult = detectToolCallLoop(sessionState, toolName, params, args.ctx.loopDetection);

    if (loopResult.stuck) {
      if (loopResult.level === "critical") {
        log.error(`Blocking ${toolName} due to critical loop: ${loopResult.message}`);
        logToolLoopAction({
          sessionKey: args.ctx.sessionKey,
          sessionId: args.ctx?.agentId,
          toolName,
          level: "critical",
          action: "block",
          detector: loopResult.detector,
          count: loopResult.count,
          message: loopResult.message,
          pairedToolName: loopResult.pairedToolName,
        });
        return {
          blocked: true,
          reason: loopResult.message,
        };
      } else {
        const warningKey = loopResult.warningKey ?? `${loopResult.detector}:${toolName}`;
        if (shouldEmitLoopWarning(sessionState, warningKey, loopResult.count)) {
          log.warn(`Loop warning for ${toolName}: ${loopResult.message}`);
          logToolLoopAction({
            sessionKey: args.ctx.sessionKey,
            sessionId: args.ctx?.agentId,
            toolName,
            level: "warning",
            action: "warn",
            detector: loopResult.detector,
            count: loopResult.count,
            message: loopResult.message,
            pairedToolName: loopResult.pairedToolName,
          });
        }
      }
    }

    recordToolCall(sessionState, toolName, params, args.toolCallId, args.ctx.loopDetection);
  }

  // PR-8: plan-mode mutation gate. Runs AFTER loop detection (loop
  // detection should still trip on stuck patterns even in plan mode)
  // and BEFORE the plugin hookRunner (so plugins can't bypass the gate
  // by handling the call earlier in the pipeline).
  //
  // Bug 3+4 + iter-2 Bug A fix: read the LATEST known planMode for
  // every tool call. `getLatestPlanMode` (wired in
  // agent-runner-execution.ts) is the live lookup for the latest
  // mode for this session; `undefined` means there is no live value
  // available to this call path. When the callback is wired and
  // returns a value, USE IT — do NOT fall back to the stale cached
  // snapshot captured at run start. The fallback to
  // `args.ctx.planMode` is reserved for environments without the
  // callback (test contexts) or when no live data is available.
  //
  // Copilot review #68939 (2026-04-19): the comment used to assert
  // a "TRUE fresh disk read" — that's the implementation detail of
  // the current backing store. Restated in terms of CONTRACT
  // (returns latest known mode; `undefined` means "no live data")
  // so future re-implementations of the callback (e.g., in-memory
  // event-driven cache) don't invalidate the doc.
  //
  // Iter-2 Bug A root cause was the previous `??` fallback chain:
  // `getLatestPlanMode() ?? planMode`. A semantic "no live data"
  // result was treated the same as a concrete mode, so when approval
  // deleted planMode on disk and the helper returned undefined, the
  // stale "plan" snapshot kept blocking post-approval mutation
  // calls. Now the helper returns "normal" on deletion AND the
  // fallback is an explicit "no live data" branch.
  const liveMode = args.ctx?.getLatestPlanMode?.();
  const latestPlanMode = liveMode !== undefined ? liveMode : args.ctx?.planMode;
  if (latestPlanMode === "plan") {
    let execCommand: string | undefined;
    if ((toolName === "exec" || toolName === "bash") && isPlainObject(params)) {
      const cmd = params.command;
      if (typeof cmd === "string") {
        execCommand = cmd;
      }
    }
    const gateResult = checkMutationGate(toolName, latestPlanMode, execCommand);
    if (gateResult.blocked) {
      return {
        blocked: true,
        reason: gateResult.reason ?? `Tool "${toolName}" is blocked while plan mode is active.`,
      };
    }
  } else if (latestPlanMode === "normal" && args.ctx?.getLatestAcceptEdits?.()) {
    // Post-approval acceptEdits gate. Only runs when:
    //   (a) mode is "normal" (plan already approved + closed), AND
    //   (b) the user granted acceptEdits via "Accept, allow edits".
    // Blocks the three hard constraints (destructive / self-restart /
    // config-change) that override acceptEdits regardless of agent
    // confidence. Fail-open otherwise — general mutations stay
    // unblocked in post-approval execution.
    let execCommand: string | undefined;
    let filePath: string | undefined;
    if ((toolName === "exec" || toolName === "bash") && isPlainObject(params)) {
      const cmd = params.command;
      if (typeof cmd === "string") {
        execCommand = cmd;
      }
    }
    if (isPlainObject(params)) {
      const candidate = params.path ?? params.filePath ?? params.file_path;
      if (typeof candidate === "string") {
        filePath = candidate;
      }
    }
    // Codex P2 review #68939 (post-nuclear-fix-stack): for
    // `apply_patch`, the target paths live in `params.input` (a
    // patch text with `*** Update File: <path>` / `*** Add File:
    // <path>` / `*** Delete File: <path>` headers). Extract them
    // and feed into the gate's `additionalPaths` so the
    // protected-config-path block fires for patches that touch
    // ~/.openclaw/* etc.
    let additionalPaths: string[] | undefined;
    if (toolName === "apply_patch" && isPlainObject(params)) {
      const extracted = extractApplyPatchTargetPaths(params.input);
      if (extracted.length > 0) {
        additionalPaths = extracted;
      }
    }
    const acceptEditsResult = checkAcceptEditsConstraint({
      toolName,
      execCommand,
      filePath,
      ...(additionalPaths ? { additionalPaths } : {}),
    });
    if (acceptEditsResult.blocked) {
      return {
        blocked: true,
        reason:
          acceptEditsResult.reason ?? `Tool "${toolName}" is blocked under acceptEdits permission.`,
      };
    }
  }

  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_tool_call")) {
    return { blocked: false, params: args.params };
  }

  try {
    const normalizedParams = isPlainObject(params) ? params : {};
    const toolContext = {
      toolName,
      ...(args.ctx?.agentId && { agentId: args.ctx.agentId }),
      ...(args.ctx?.sessionKey && { sessionKey: args.ctx.sessionKey }),
      ...(args.ctx?.sessionId && { sessionId: args.ctx.sessionId }),
      ...(args.ctx?.runId && { runId: args.ctx.runId }),
      ...(args.toolCallId && { toolCallId: args.toolCallId }),
    };
    const hookResult = await hookRunner.runBeforeToolCall(
      {
        toolName,
        params: normalizedParams,
        ...(args.ctx?.runId && { runId: args.ctx.runId }),
        ...(args.toolCallId && { toolCallId: args.toolCallId }),
      },
      toolContext,
    );

    if (hookResult?.block) {
      return {
        blocked: true,
        reason: hookResult.blockReason || "Tool call blocked by plugin hook",
      };
    }

    if (hookResult?.requireApproval) {
      const approval = hookResult.requireApproval;
      const safeOnResolution = (resolution: PluginApprovalResolution): void => {
        const onResolution = approval.onResolution;
        if (typeof onResolution !== "function") {
          return;
        }
        try {
          void Promise.resolve(onResolution(resolution)).catch((err) => {
            log.warn(`plugin onResolution callback failed: ${String(err)}`);
          });
        } catch (err) {
          log.warn(`plugin onResolution callback failed: ${String(err)}`);
        }
      };
      try {
        const requestResult: {
          id?: string;
          status?: string;
          decision?: string | null;
        } = await callGatewayTool(
          "plugin.approval.request",
          // Buffer beyond the approval timeout so the gateway can clean up
          // and respond before the client-side RPC timeout fires.
          { timeoutMs: (approval.timeoutMs ?? 120_000) + 10_000 },
          {
            pluginId: approval.pluginId,
            title: approval.title,
            description: approval.description,
            severity: approval.severity,
            toolName,
            toolCallId: args.toolCallId,
            agentId: args.ctx?.agentId,
            sessionKey: args.ctx?.sessionKey,
            timeoutMs: approval.timeoutMs ?? 120_000,
            twoPhase: true,
          },
          { expectFinal: false },
        );
        const id = requestResult?.id;
        if (!id) {
          safeOnResolution(PluginApprovalResolutions.CANCELLED);
          return {
            blocked: true,
            reason: approval.description || "Plugin approval request failed",
          };
        }
        const hasImmediateDecision = Object.prototype.hasOwnProperty.call(
          requestResult ?? {},
          "decision",
        );
        let decision: string | null | undefined;
        if (hasImmediateDecision) {
          decision = requestResult?.decision;
          if (decision === null) {
            safeOnResolution(PluginApprovalResolutions.CANCELLED);
            return {
              blocked: true,
              reason: "Plugin approval unavailable (no approval route)",
            };
          }
        } else {
          // Wait for the decision, but abort early if the agent run is cancelled
          // so the user isn't blocked for the full approval timeout.
          const waitPromise: Promise<{
            id?: string;
            decision?: string | null;
          }> = callGatewayTool(
            "plugin.approval.waitDecision",
            // Buffer beyond the approval timeout so the gateway can clean up
            // and respond before the client-side RPC timeout fires.
            { timeoutMs: (approval.timeoutMs ?? 120_000) + 10_000 },
            { id },
          );
          let waitResult: { id?: string; decision?: string | null } | undefined;
          if (args.signal) {
            let onAbort: (() => void) | undefined;
            const abortPromise = new Promise<never>((_, reject) => {
              if (args.signal!.aborted) {
                reject(args.signal!.reason);
                return;
              }
              onAbort = () => reject(args.signal!.reason);
              args.signal!.addEventListener("abort", onAbort, { once: true });
            });
            try {
              waitResult = await Promise.race([waitPromise, abortPromise]);
            } finally {
              if (onAbort) {
                args.signal.removeEventListener("abort", onAbort);
              }
            }
          } else {
            waitResult = await waitPromise;
          }
          decision = waitResult?.decision;
        }
        const resolution: PluginApprovalResolution =
          decision === PluginApprovalResolutions.ALLOW_ONCE ||
          decision === PluginApprovalResolutions.ALLOW_ALWAYS ||
          decision === PluginApprovalResolutions.DENY
            ? decision
            : PluginApprovalResolutions.TIMEOUT;
        safeOnResolution(resolution);
        if (
          decision === PluginApprovalResolutions.ALLOW_ONCE ||
          decision === PluginApprovalResolutions.ALLOW_ALWAYS
        ) {
          return {
            blocked: false,
            params: mergeParamsWithApprovalOverrides(params, hookResult.params),
          };
        }
        if (decision === PluginApprovalResolutions.DENY) {
          return { blocked: true, reason: "Denied by user" };
        }
        const timeoutBehavior = approval.timeoutBehavior ?? "deny";
        if (timeoutBehavior === "allow") {
          return {
            blocked: false,
            params: mergeParamsWithApprovalOverrides(params, hookResult.params),
          };
        }
        return { blocked: true, reason: "Approval timed out" };
      } catch (err) {
        safeOnResolution(PluginApprovalResolutions.CANCELLED);
        if (isAbortSignalCancellation(err, args.signal)) {
          log.warn(`plugin approval wait cancelled by run abort: ${String(err)}`);
          return {
            blocked: true,
            reason: "Approval cancelled (run aborted)",
          };
        }
        log.warn(`plugin approval gateway request failed; blocking tool call: ${String(err)}`);
        return {
          blocked: true,
          reason: "Plugin approval required (gateway unavailable)",
        };
      }
    }

    if (hookResult?.params) {
      return {
        blocked: false,
        params: mergeParamsWithApprovalOverrides(params, hookResult.params),
      };
    }
  } catch (err) {
    const toolCallId = args.toolCallId ? ` toolCallId=${args.toolCallId}` : "";
    const cause = unwrapErrorCause(err);
    log.error(`before_tool_call hook failed: tool=${toolName}${toolCallId} error=${String(cause)}`);
    return {
      blocked: true,
      reason: BEFORE_TOOL_CALL_HOOK_FAILURE_REASON,
    };
  }

  return { blocked: false, params };
}

export function wrapToolWithBeforeToolCallHook(
  tool: AnyAgentTool,
  ctx?: HookContext,
): AnyAgentTool {
  const execute = tool.execute;
  if (!execute) {
    return tool;
  }
  const toolName = tool.name || "tool";
  const wrappedTool: AnyAgentTool = {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const outcome = await runBeforeToolCallHook({
        toolName,
        params,
        toolCallId,
        ctx,
        signal,
      });
      if (outcome.blocked) {
        throw new Error(outcome.reason);
      }
      if (toolCallId) {
        const adjustedParamsKey = buildAdjustedParamsKey({ runId: ctx?.runId, toolCallId });
        adjustedParamsByToolCallId.set(adjustedParamsKey, outcome.params);
        if (adjustedParamsByToolCallId.size > MAX_TRACKED_ADJUSTED_PARAMS) {
          const oldest = adjustedParamsByToolCallId.keys().next().value;
          if (oldest) {
            adjustedParamsByToolCallId.delete(oldest);
          }
        }
      }
      const normalizedToolName = normalizeToolName(toolName || "tool");
      try {
        const result = await execute(toolCallId, outcome.params, signal, onUpdate);
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: outcome.params,
          toolCallId,
          result,
        });
        return result;
      } catch (err) {
        await recordLoopOutcome({
          ctx,
          toolName: normalizedToolName,
          toolParams: outcome.params,
          toolCallId,
          error: err,
        });
        throw err;
      }
    },
  };
  copyPluginToolMeta(tool, wrappedTool);
  copyChannelAgentToolMeta(tool as never, wrappedTool as never);
  Object.defineProperty(wrappedTool, BEFORE_TOOL_CALL_WRAPPED, {
    value: true,
    enumerable: true,
  });
  return wrappedTool;
}

export function isToolWrappedWithBeforeToolCallHook(tool: AnyAgentTool): boolean {
  const taggedTool = tool as unknown as Record<symbol, unknown>;
  return taggedTool[BEFORE_TOOL_CALL_WRAPPED] === true;
}

export function consumeAdjustedParamsForToolCall(toolCallId: string, runId?: string): unknown {
  const adjustedParamsKey = buildAdjustedParamsKey({ runId, toolCallId });
  const params = adjustedParamsByToolCallId.get(adjustedParamsKey);
  adjustedParamsByToolCallId.delete(adjustedParamsKey);
  return params;
}

export const __testing = {
  BEFORE_TOOL_CALL_WRAPPED,
  buildAdjustedParamsKey,
  adjustedParamsByToolCallId,
  runBeforeToolCallHook,
  mergeParamsWithApprovalOverrides,
  isPlainObject,
};

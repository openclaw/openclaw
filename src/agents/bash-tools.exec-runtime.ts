import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { formatErrorMessage } from "@openclaw/normalization-core/error-coercion";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { SessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import { recordDiagnosticToolExecutionDeadline } from "../infra/diagnostic-tool-execution-liveness.js";
import type { EventSessionRoutingPolicy } from "../infra/event-session-routing.js";
import {
  DEFAULT_EXEC_APPROVAL_TIMEOUT_MS,
  resolveExecApprovalAllowedDecisions,
  type ExecApprovalDecision,
} from "../infra/exec-approvals.js";
import {
  execRequestAbortSignal,
  retainExecRequestProcess,
  withExecRequestOwners,
  type ExecRequestOwner,
} from "../infra/exec-request-context.js";
import { findPathKey, mergePathPrepend } from "../infra/path-prepend.js";
import { logWarn } from "../logger.js";
import { redactToolPayloadText } from "../logging/redact.js";
import { resolveHostExecMemoryLimit } from "../process/child-memory.js";
import { withChildProcessOperation } from "../process/spawn-diagnostics.js";
import type { SpawnInitiation } from "../process/spawn-initiation.js";
import { getProcessSupervisor, type ManagedRun } from "../process/supervisor/index.js";
import type { SpawnInput } from "../process/supervisor/types.js";
import type {
  SecretEgressProcessGrant,
  SecretEgressSentinelBinding,
} from "../secrets/egress-proxy/proxy-server.js";
import { registerSecretEgressProxyProcess } from "../secrets/egress-proxy/registry.js";
/**
 * Spawns host/sandbox processes, manages session updates/backgrounding,
 * approval messaging constants, environment safety, and exit outcome shaping.
 */
import { formatFencedCodeBlock } from "../shared/markdown-code.js";
import {
  normalizeDeliveryContext,
  type DeliveryContext,
} from "../utils/delivery-context.shared.js";
import { resolveSafeTimeoutDelayMs } from "../utils/timer-delay.js";
import {
  captureAgentToolSourceExecutionGuard,
  runWithAgentToolSourceExecutionScope,
} from "./agent-tool-source-execution-guard.js";
import type { ProcessSession } from "./bash-process-registry.js";
import {
  addSession,
  appendOutput,
  createProcessSession,
  isProcessSessionIdTaken,
  markCancellationRequested,
  resolveProcessCleanupMs,
  waitForExecSession,
} from "./bash-process-registry.js";
import { emitExecProcessCompleted } from "./bash-tools.exec-diagnostics.js";
import { prepareHostExecSpawn, resolveExecLaunchEnv } from "./bash-tools.exec-host-spawn.js";
import { createExecLaunchLifecycle } from "./bash-tools.exec-launch.js";
import { maybeNotifyOnExit, prepareExecExitNotification } from "./bash-tools.exec-notify.js";
import {
  buildExecExitOutcome,
  buildExecRuntimeErrorOutcome,
  joinExecFailureOutput,
  type ExecProcessOutcome,
  renderExecUpdateText,
} from "./bash-tools.exec-output.js";
import { settleExecProcessExit } from "./bash-tools.exec-settlement.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";
import { chunkString, clampWithDefault, readEnvInt } from "./bash-tools.shared.js";
import { recordAgentCleanupFailure } from "./run-cleanup-timeout.js";
import type { AgentToolResult } from "./runtime/index.js";
import { createSessionSlug } from "./session-slug.js";
import { createStreamingBinaryOutputSanitizer } from "./shell-utils.js";
import {
  getGatewayToolCallerIdentity,
  withoutGatewayToolCallerIdentity,
} from "./tools/gateway-caller-context.js";
export { applyPathPrepend, normalizePathPrepend } from "../infra/path-prepend.js";

function resolveExecTimeoutMs(timeoutSec: number | null | undefined): number | undefined {
  if (typeof timeoutSec !== "number" || !Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    return undefined;
  }
  return resolveSafeTimeoutDelayMs(timeoutSec * 1000);
}

/** Default retained aggregate output cap for exec sessions. */
export const DEFAULT_MAX_OUTPUT = clampWithDefault(
  readEnvInt("OPENCLAW_BASH_MAX_OUTPUT_CHARS", "PI_BASH_MAX_OUTPUT_CHARS"),
  200_000,
  1_000,
  200_000,
);
/** Default pending output cap for poll/update buffers. */
export const DEFAULT_PENDING_MAX_OUTPUT = clampWithDefault(
  readEnvInt("OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS"),
  30_000,
  1_000,
  200_000,
);
/** Fallback PATH used when the process environment has no PATH. */
export const DEFAULT_PATH =
  process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
export const DEFAULT_APPROVAL_TIMEOUT_MS = DEFAULT_EXEC_APPROVAL_TIMEOUT_MS;
/** Gateway request timeout for approval registration/wait calls. */
export const DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS = DEFAULT_APPROVAL_TIMEOUT_MS + 10_000;
const DEFAULT_APPROVAL_RUNNING_NOTICE_MS = 10_000;
const APPROVAL_SLUG_LENGTH = 8;

/** Live handle returned after an exec process has started. */
export type ExecProcessHandle = {
  session: ProcessSession;
  startedAt: number;
  pid?: number;
  promise: Promise<ExecProcessOutcome>;
  kill: () => void;
  /** Immediately suppress all future `onUpdate` calls for this handle. */
  disableUpdates: () => void;
};

/** Merges shell-discovered PATH entries into an exec environment. */
export function applyShellPath(env: Record<string, string>, shellPath?: string | null) {
  if (!shellPath) {
    return;
  }
  const entries = normalizeStringEntries(shellPath.split(path.delimiter));
  if (entries.length === 0) {
    return;
  }
  const pathKey = findPathKey(env);
  const merged = mergePathPrepend(env[pathKey], entries);
  if (merged) {
    env[pathKey] = merged;
  }
}

/** Creates the short approval id shown in `/approve` prompts. */
export function createApprovalSlug(id: string) {
  return id.slice(0, APPROVAL_SLUG_LENGTH);
}

/** Builds the user-facing approval-pending message for foreground exec. */
export function buildApprovalPendingMessage(params: {
  warningText?: string;
  approvalSlug: string;
  approvalId: string;
  allowedDecisions?: readonly ExecApprovalDecision[];
  command: string;
  cwd: string | undefined;
  host: "gateway" | "node";
  nodeId?: string;
  processContinuationAvailable?: boolean;
}) {
  const commandBlock = formatFencedCodeBlock(params.command, "sh");
  const lines: string[] = [];
  const allowedDecisions = params.allowedDecisions ?? resolveExecApprovalAllowedDecisions();
  const decisionText = allowedDecisions.join("|");
  const warningText = params.warningText?.trim();
  if (warningText) {
    lines.push(warningText, "");
  }
  lines.push(`Approval required (id ${params.approvalSlug}, full ${params.approvalId}).`);
  lines.push(`Host: ${params.host}`);
  if (params.nodeId) {
    lines.push(`Node: ${params.nodeId}`);
  }
  lines.push(`CWD: ${params.cwd ?? "(node default)"}`);
  lines.push("Command:");
  lines.push(commandBlock);
  lines.push("Mode: foreground (interactive approvals available).");
  if (params.processContinuationAvailable !== false) {
    lines.push(
      allowedDecisions.includes("allow-always")
        ? "Background mode requires pre-approved policy (allow-always or ask=off)."
        : "Background mode requires an effective policy that allows pre-approval (for example ask=off).",
    );
  }
  lines.push(`Reply with: /approve ${params.approvalSlug} ${decisionText}`);
  if (!allowedDecisions.includes("allow-always")) {
    lines.push("Allow Always is unavailable for this command.");
  }
  lines.push("If the short code is ambiguous, use the full id in /approve.");
  return lines.join("\n");
}

export function resolveApprovalRunningNoticeMs(value?: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_APPROVAL_RUNNING_NOTICE_MS;
  }
  if (value <= 0) {
    return 0;
  }
  return Math.floor(value);
}

/** Starts a host or sandbox exec process and registers it for polling/backgrounding. */
export async function runExecProcess({
  startupSignal: initialStartupSignal,
  onUpdate: initialOnUpdate,
  beforeSpawn: initialBeforeSpawn,
  assertCurrent: initialAssertCurrent,
  initiateSpawn: initialInitiateSpawn,
  releaseSpawn: initialReleaseSpawn,
  onSettledBeforeNotify: initialOnSettledBeforeNotify,
  ...opts
}: {
  command: string;
  // Execute this instead of `command` (which is kept for display/session/logging).
  // Used to sanitize safeBins execution while preserving the original user input.
  execCommand?: string;
  workdir: string;
  env: Record<string, string>;
  secretEgressBindings?: readonly SecretEgressSentinelBinding[];
  /** Host-selected managed profile; never inferred from the requested environment. */
  githubProfileDir?: string;
  pathPrepend?: string[];
  sandbox?: BashSandboxConfig;
  containerWorkdir?: string | null;
  usePty: boolean;
  warnings: string[];
  maxOutput: number;
  pendingMaxOutput: number;
  cleanupMs?: number;
  notifyOnExit: boolean;
  /** Start-time subagent identity resolved from the persisted spawn envelope. */
  subagentSession?: boolean;
  notifyOnExitEmptySuccess?: boolean;
  requestOwners?: readonly ExecRequestOwner[];
  scopeKey?: string;
  sessionKey?: string;
  agentId?: string;
  /** Start-time routing policy for detached exec system events. */
  eventRouting?: EventSessionRoutingPolicy;
  notifyDeliveryContext?: DeliveryContext;
  timeoutSec: number | null;
  /** Whether exec may return a supervised session for later continuation. */
  processContinuationAvailable?: boolean;
  /** Cancels startup only; background process lifetime belongs to the supervisor. */
  startupSignal?: AbortSignal;
  onUpdate?: (partialResult: AgentToolResult<ExecToolDetails>) => void;
  /** Runs after process finalization and before the exit wake is queued. */
  onSettledBeforeNotify?: (outcome: ExecProcessOutcome) => void | Promise<void>;
  /** Revalidates authorization after async preparation, immediately before each spawn attempt. */
  beforeSpawn?: () => Promise<AgentToolResult<ExecToolDetails> | undefined>;
  /** Rechecks host policy at the supervisor's final synchronous spawn boundary. */
  assertCurrent?: () => void;
  initiateSpawn?: SpawnInitiation;
  releaseSpawn?: (reason?: "retry") => void;
}): Promise<ExecProcessHandle> {
  const requestSignal = execRequestAbortSignal(opts.requestOwners);
  const startupSignal =
    requestSignal && initialStartupSignal
      ? AbortSignal.any([requestSignal, initialStartupSignal])
      : (requestSignal ?? initialStartupSignal);
  let assertSourceActive: SessionSourceAssertion | undefined =
    captureAgentToolSourceExecutionGuard(startupSignal);
  let operatorAuthority = getGatewayToolCallerIdentity()?.operatorAuthority;
  const operatorSignal = operatorAuthority?.signal;
  let releaseOperatorAuthority: (() => void) | undefined;
  const startedAt = Date.now();
  const sessionId = createSessionSlug(isProcessSessionIdTaken);
  const execCommand = opts.execCommand ?? opts.command;
  const diagnosticTarget = opts.sandbox ? "sandbox" : "host";
  const supervisor = getProcessSupervisor();
  const shellRuntimeEnv: Record<string, string> = {
    ...opts.env,
    OPENCLAW_SHELL: "exec",
  };

  const session: ProcessSession = createProcessSession(
    withExecRequestOwners(
      {
        id: sessionId,
        command: opts.command,
        scopeKey: opts.scopeKey,
        sessionKey: opts.sessionKey,
        cleanupMs: resolveProcessCleanupMs(opts.cleanupMs),
        agentId: opts.agentId,
        eventRouting: opts.eventRouting,
        notifyDeliveryContext: normalizeDeliveryContext(opts.notifyDeliveryContext),
        notifyOnExit: opts.notifyOnExit,
        notifyOnExitEmptySuccess: opts.notifyOnExitEmptySuccess === true,
        exitNotified: false,
        startedAt,
        cwd: opts.workdir,
        maxOutputChars: opts.maxOutput,
        pendingMaxOutputChars: opts.pendingMaxOutput,
        totalOutputChars: 0,
        pendingStdoutChars: 0,
        pendingStderrChars: 0,
        pendingOutputDropped: false,
        exited: false,
        truncated: false,
        backgrounded: false,
        cursorKeyMode: opts.usePty ? "unknown" : "normal",
      },
      opts.requestOwners,
    ),
  );
  withoutGatewayToolCallerIdentity(() => addSession(session));
  if (opts.requestOwners?.length) {
    retainExecRequestProcess(opts.requestOwners, waitForExecSession(session));
  }

  const notificationTarget = prepareExecExitNotification(session, opts.subagentSession === true);
  if (notificationTarget) {
    await notificationTarget;
  }

  // Foreground delivery keeps its caller context only until yield, abort, or exit.
  // Clearing the callback also releases the completed turn's captured authority.
  let onUpdate = initialOnUpdate && AsyncLocalStorage.bind(initialOnUpdate);
  let beforeSpawn = initialBeforeSpawn;
  let assertPolicyCurrent = initialAssertCurrent;
  let onSettledBeforeNotify = initialOnSettledBeforeNotify;

  const emitUpdate = () => {
    if (!onUpdate || session.backgrounded || session.exited) {
      return;
    }
    const tailText = session.tail;
    onUpdate({
      content: [
        {
          type: "text",
          text: renderExecUpdateText({
            tailText: tailText || session.aggregated,
            warnings: opts.warnings,
          }),
        },
      ],
      details: {
        status: "running",
        sessionId,
        pid: session.pid ?? undefined,
        startedAt,
        cwd: session.cwd,
        tail: tailText,
      },
    });
  };

  // One parser per stream so ESC sequences split across chunks are not mangled.
  const sanitizeStdout = createStreamingBinaryOutputSanitizer((sequence) => {
    if (sequence === "?1h" || sequence === "?1l") {
      session.cursorKeyMode = sequence === "?1h" ? "application" : "normal";
    } else if (usingPty && (sequence === "6n" || sequence === "?6n")) {
      managedRun?.stdin?.write("\x1b[1;1R");
    }
  });
  const sanitizeStderr = createStreamingBinaryOutputSanitizer();

  const handleOutput =
    (stream: "stdout" | "stderr", sanitize: (data: string) => string) => (data: string) => {
      for (const chunk of chunkString(sanitize(data))) {
        appendOutput(session, stream, chunk);
        emitUpdate();
      }
    };

  const timeoutMs = resolveExecTimeoutMs(opts.timeoutSec);
  let sandboxFinalizeToken: unknown;
  let assertSandboxCurrent: (() => void) | undefined;
  let sandboxPrepared = false;
  let terminateSandboxProcess: (() => Promise<void>) | undefined;
  let sandboxTermination: Promise<{ error: unknown } | undefined> | undefined;
  let secretEgressGrant: SecretEgressProcessGrant | undefined;
  const beginSandboxTermination = () => {
    const terminate = terminateSandboxProcess;
    if (!terminate || sandboxTermination || session.exited) {
      return;
    }
    sandboxTermination = withoutGatewayToolCallerIdentity(async () => {
      try {
        await terminate();
        return undefined;
      } catch (error) {
        return { error };
      }
    });
  };
  const finalizeSandboxExec = async (params: {
    status: "completed" | "failed";
    exitCode: number | null;
    timedOut: boolean;
  }) => {
    if (!sandboxPrepared || !opts.sandbox?.finalizeExec) {
      return;
    }
    await opts.sandbox.finalizeExec({
      ...params,
      token: sandboxFinalizeToken,
    });
  };
  const runtimeErrorOutcome = (error: unknown) =>
    buildExecRuntimeErrorOutcome({
      error,
      aggregated: session.aggregated.trim(),
      durationMs: Date.now() - startedAt,
    });
  const finalizeAndSettleSession = async (
    outcome: ExecProcessOutcome,
  ): Promise<ExecProcessOutcome> => {
    secretEgressGrant?.revoke();
    let finalOutcome = outcome;
    session.finalizing = true;
    try {
      if (!opts.sandbox && managedRun?.waitForExtinction) {
        // Root completion does not release descendants that retained the group's lineage fd.
        managedRun.cancel();
        const extinction = await managedRun.waitForExtinction();
        session.cleanupUncertain = extinction?.status === "uncertain";
        if (session.requestCancelled && session.cleanupUncertain) {
          throw new Error("Command descendant cleanup could not be confirmed");
        }
      }
      if (outcome.exitReason !== "exit") {
        beginSandboxTermination();
      }
      await sandboxTermination;
      const [artifacts] = await Promise.allSettled([
        finalizeSandboxExec({
          status: outcome.status,
          exitCode: outcome.exitCode,
          timedOut: outcome.timedOut,
        }),
      ]);
      // Cancellation may arrive while the backend is finalizing its artifacts.
      const termination = sandboxTermination ? await sandboxTermination : undefined;
      const errors = termination ? [termination.error] : [];
      if (artifacts.status === "rejected") {
        errors.push(artifacts.reason);
      }
      if (errors.length > 0) {
        const message = errors.map((error) => formatErrorMessage(error)).join("\n");
        throw new AggregateError(errors, message);
      }
    } catch (error) {
      session.finalizationFailed = true;
      recordAgentCleanupFailure();
      // Mask host cleanup diagnostics before they enter retained process output.
      const detail = redactToolPayloadText(formatErrorMessage(error));
      if (outcome.status === "completed") {
        finalOutcome = runtimeErrorOutcome(detail);
      } else {
        finalOutcome = { ...outcome, reason: joinExecFailureOutput(outcome.reason, detail) };
        logWarn(`exec: finalization after process failure failed (${detail}).`);
      }
      // Failed commands retain cleanup failures in the same bounded tool output.
      appendOutput(session, "stderr", `\n${detail}\n`);
      finalOutcome.aggregated = session.aggregated.trim();
    } finally {
      finalOutcome = await settleExecProcessExit({
        session,
        outcome: finalOutcome,
        onSettledBeforeNotify,
        notifyOnExit: (settledSession, status) =>
          maybeNotifyOnExit(settledSession, status, opts.subagentSession === true),
        failureOutcome: runtimeErrorOutcome,
      });
    }
    return finalOutcome;
  };

  const prepareSpawnSpec = async () => {
    if (opts.sandbox) {
      if (!opts.sandbox.buildExecSpec) {
        throw new Error("sandbox backend does not provide buildExecSpec");
      }
      const cleanup = opts.sandbox.prepareProcessCleanup?.(shellRuntimeEnv);
      terminateSandboxProcess = cleanup?.terminate.bind(cleanup);
      const backendExecSpec = await opts.sandbox.buildExecSpec({
        command: execCommand,
        workdir: opts.containerWorkdir ?? opts.sandbox.containerWorkdir,
        env: cleanup?.env ?? shellRuntimeEnv,
        usePty: opts.usePty,
      });
      sandboxFinalizeToken = backendExecSpec.finalizeToken;
      assertSandboxCurrent = backendExecSpec.assertCurrent;
      // Cleanup ownership transfers only after buildExecSpec resolves: moving this earlier can
      // double-finalize backend failures, while removing it leaks the registered exec session.
      sandboxPrepared = true;
      return {
        mode: "child" as const,
        argv: backendExecSpec.argv,
        env: backendExecSpec.env,
        cwd: backendExecSpec.cwd,
        stdinMode: backendExecSpec.stdinMode,
      };
    }
    return prepareHostExecSpawn({ ...opts, env: shellRuntimeEnv });
  };

  let managedRun: ManagedRun | null = null;
  const onRequestCancelled = () => {
    session.requestCancelled = true;
    markCancellationRequested(session);
    onUpdate = undefined;
    if (managedRun) {
      managedRun.cancel("manual-cancel");
    } else {
      // The supervisor reserves the process identity before asynchronous launch completes.
      supervisor.cancel(sessionId, "manual-cancel");
    }
    beginSandboxTermination();
  };
  requestSignal?.addEventListener("abort", onRequestCancelled, { once: true });
  if (requestSignal?.aborted) {
    onRequestCancelled();
  }
  const launchLifecycle = createExecLaunchLifecycle(initialInitiateSpawn, initialReleaseSpawn);
  const onOperatorRevoked = () => managedRun?.cancel("manual-cancel");
  const releaseExecutionContext = () => {
    onSettledBeforeNotify = undefined;
    operatorSignal?.removeEventListener("abort", onOperatorRevoked);
    releaseOperatorAuthority?.();
    releaseOperatorAuthority = undefined;
    requestSignal?.removeEventListener("abort", onRequestCancelled);
  };
  let usingPty = opts.usePty && !opts.sandbox;
  const emitCompleted = (outcome: ExecProcessOutcome) =>
    emitExecProcessCompleted({
      command: opts.command,
      mode: usingPty ? "pty" : "child",
      outcome,
      sessionKey: opts.sessionKey,
      target: diagnosticTarget,
    });
  const assertPreSpawnAuthorized = () => launchLifecycle.prepare(assertSourceActive, beforeSpawn);
  const spawn = (input: SpawnInput) =>
    runWithAgentToolSourceExecutionScope(assertSourceActive, async () => {
      const assertSourceCurrent = assertSourceActive;
      const assertOperatorCurrent = operatorAuthority?.assertCurrent;
      const assertRuntimeCurrent = assertSandboxCurrent;
      const assertHostPolicyCurrent = assertPolicyCurrent;
      const assertCurrent = () => {
        assertSourceCurrent?.();
        assertOperatorCurrent?.();
        assertRuntimeCurrent?.();
      };
      // Source authority covers construction; approval policy ends at native launch.
      assertCurrent();
      assertHostPolicyCurrent?.();
      const grant = opts.secretEgressBindings
        ? await registerSecretEgressProxyProcess(opts.secretEgressBindings)
        : undefined;
      secretEgressGrant = grant;
      try {
        return await withChildProcessOperation("agent.exec", () =>
          withoutGatewayToolCallerIdentity(() =>
            supervisor.spawn({
              ...input,
              env: resolveExecLaunchEnv(input.env, Boolean(opts.sandbox), grant?.env),
              onCancel: () => {
                beginSandboxTermination();
                grant?.revoke();
              },
              assertCurrent,
              beforeSpawn: assertHostPolicyCurrent,
              initiateSpawn: launchLifecycle.wrap(assertCurrent, assertHostPolicyCurrent),
            }),
          ),
        );
      } catch (error) {
        grant?.revoke();
        throw error;
      }
    });

  try {
    assertSourceActive?.();
    operatorAuthority?.assertCurrent();
    releaseOperatorAuthority = operatorAuthority?.retain?.();
    const spawnSpec = await prepareSpawnSpec();
    usingPty = spawnSpec.mode === "pty";
    const spawnBase = {
      runId: sessionId,
      ...(opts.sandbox ? { cleanupOwnership: "external" as const, exactEnv: true as const } : {}),
      scopeKey: opts.scopeKey,
      cwd: spawnSpec.cwd ?? opts.workdir,
      env: spawnSpec.env,
      timeoutMs,
      memoryLimitBytes: opts.sandbox ? undefined : resolveHostExecMemoryLimit(),
      captureOutput: false,
      onStdout: handleOutput("stdout", sanitizeStdout),
      onStderr: handleOutput("stderr", sanitizeStderr),
    };
    await assertPreSpawnAuthorized();
    if (spawnSpec.mode === "pty") {
      try {
        managedRun = await spawn({
          ...spawnBase,
          mode: "pty",
          argv: spawnSpec.argv,
        });
      } catch (err) {
        if (launchLifecycle.initiated) {
          launchLifecycle.release();
          throw err;
        }
        launchLifecycle.release("retry");
        assertSourceActive?.();
        const warning = `Warning: PTY spawn failed (${String(err)}); retrying without PTY for \`${opts.command}\`.`;
        logWarn(
          `exec: PTY spawn failed (${String(err)}); retrying without PTY for "${opts.command}".`,
        );
        opts.warnings.push(warning);
        usingPty = false;
        await assertPreSpawnAuthorized();
      }
    }
    if (!managedRun) {
      managedRun = await spawn({
        ...spawnBase,
        mode: "child",
        argv: spawnSpec.argv,
        stdinMode: spawnSpec.stdinMode,
      });
    }
    // Background execution outlives the turn, but never its original access grant.
    operatorSignal?.addEventListener("abort", onOperatorRevoked, { once: true });
    if (operatorSignal?.aborted) {
      onOperatorRevoked();
    }
  } catch (error) {
    launchLifecycle.release();
    onUpdate = undefined;
    const outcome = await finalizeAndSettleSession(runtimeErrorOutcome(error)).finally(
      releaseExecutionContext,
    );
    emitCompleted(outcome);
    throw error;
  } finally {
    launchLifecycle.dispose();
    beforeSpawn = undefined;
    assertPolicyCurrent = undefined;
    assertSourceActive = undefined;
    operatorAuthority = undefined;
    assertSandboxCurrent = undefined;
  }
  session.processActivity = managedRun.activity;
  recordDiagnosticToolExecutionDeadline(managedRun.activity.deadlineAtMs);
  session.stdin = managedRun.stdin;
  session.pid = managedRun.pid;

  const startedRun = managedRun;
  const promise = withoutGatewayToolCallerIdentity(async (): Promise<ExecProcessOutcome> => {
    try {
      let outcome: ExecProcessOutcome;
      try {
        const exit = await startedRun.wait();
        outcome = buildExecExitOutcome({
          exit,
          aggregated: session.aggregated.trim(),
          durationMs: Date.now() - startedAt,
          timeoutSec: opts.timeoutSec,
          processContinuationAvailable: opts.processContinuationAvailable !== false,
        });
      } catch (error) {
        outcome = runtimeErrorOutcome(error);
      } finally {
        // Release foreground delivery before finalization marks the record exited.
        onUpdate = undefined;
      }
      const finalOutcome = await finalizeAndSettleSession(outcome);
      emitCompleted(finalOutcome);
      return finalOutcome;
    } finally {
      releaseExecutionContext();
    }
  });

  return {
    session,
    startedAt,
    pid: session.pid ?? undefined,
    promise,
    kill: () => {
      managedRun?.cancel("manual-cancel");
    },
    disableUpdates: () => {
      onUpdate = undefined;
    },
  };
}

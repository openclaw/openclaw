import type { CliDeps } from "../../cli/deps.types.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../infra/agent-events.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  createUserTurnTranscriptRecorder,
  buildRunUserTurnIdempotencyKey,
} from "../../sessions/user-turn-transcript.js";
import { runSupervisedForegroundAdmission } from "../../tasks/supervised-task.foreground.js";
import { bindSupervisedRootSource } from "../../tasks/supervised-task.root-source.js";
import type { AgentCommandAdmissionIngress } from "../agent-command-execution-identity.js";
import { runAgentHarnessBeforeMessageWriteHook } from "../harness/hook-helpers.js";
import type { deliverAgentCommandResult } from "./delivery.js";
import type { PreparedAgentCommandExecution } from "./prepare.js";
import { loadDeliveryRuntime, type loadSessionStoreRuntime } from "./runtime-loaders.js";
import type { AgentCommandOpts } from "./types.js";

export function isSupervisedLocalRoot(params: {
  prepared: PreparedAgentCommandExecution;
  opts: AgentCommandOpts;
  ingress: AgentCommandAdmissionIngress;
}) {
  const { prepared, opts } = params;
  return Boolean(
    params.ingress.kind === "local-cli" &&
    opts.senderIsOwner === true &&
    prepared.sessionKey &&
    prepared.cfg.agents?.entries?.[prepared.sessionAgentId]?.taskSupervision?.enabled &&
    !prepared.isSubagentLane &&
    !prepared.sessionEntry?.spawnedBy &&
    !opts.inputProvenance &&
    !opts.internalEvents?.length &&
    !opts.bootstrapContextRunKind &&
    !opts.modelRun &&
    opts.promptMode !== "none" &&
    opts.sessionEffects !== "internal" &&
    !opts.suppressPromptPersistence &&
    !opts.transcriptMedia?.length,
  );
}

/** The private local ingress fact authorizes classification; neither prompt
 * text nor public opts can turn a system/runtime attempt into this root path. */
export async function maybeRunSupervisedLocalRoot(params: {
  prepared: PreparedAgentCommandExecution;
  opts: AgentCommandOpts;
  ingress: AgentCommandAdmissionIngress;
  model: string;
  assertCurrent: () => void;
  onError: (error: unknown) => void;
}) {
  if (!isSupervisedLocalRoot(params)) {
    return undefined;
  }
  const { prepared, opts } = params;
  const sessionKey = prepared.sessionKey;
  if (!sessionKey) {
    throw new Error("Supervised local root requires a canonical session");
  }
  params.assertCurrent();
  const recorder =
    opts.userTurnTranscriptRecorder ??
    createUserTurnTranscriptRecorder({
      input: {
        text: prepared.transcriptBody,
        senderIsOwner: true,
        idempotencyKey: buildRunUserTurnIdempotencyKey(prepared.runId),
      },
      beforeMessageWrite: runAgentHarnessBeforeMessageWriteHook,
      target: {
        sessionId: prepared.sessionId,
        expectedSessionId: prepared.sessionId,
        sessionKey,
        sessionEntry: prepared.sessionEntry,
        sessionStore: prepared.sessionStore,
        storePath: prepared.storePath,
        agentId: prepared.sessionAgentId,
        cwd: prepared.cwd ?? prepared.workspaceDir,
        config: prepared.cfg,
      },
    });
  // Ordinary classification must reuse this same persisted input, not append
  // another user turn when the normal runtime takes over.
  opts.userTurnTranscriptRecorder = recorder;
  const persisted = await recorder.persistApproved({ expectedSessionId: prepared.sessionId });
  params.assertCurrent();
  if (!persisted || persisted.admission.sessionId !== prepared.sessionId) {
    throw new Error("Local input transcript custody was not committed");
  }
  return runSupervisedForegroundAdmission({
    config: prepared.cfg,
    source: bindSupervisedRootSource({
      config: prepared.cfg,
      agentId: prepared.sessionAgentId,
      sessionKey,
      sessionId: prepared.sessionId,
      namespace: "local",
      inputId: prepared.runId,
    }),
    message: prepared.body,
    model: params.model,
    ownerAuthorized: true,
    internal: false,
    assertCurrent: params.assertCurrent,
    signal: opts.abortSignal,
    onError: params.onError,
    onHandoff: async () => {
      params.assertCurrent();
    },
  });
}

/** Run and present a foreground root while reusing its prepared source identity. */
export async function runSupervisedLocalRootCommand(params: {
  prepared: PreparedAgentCommandExecution;
  opts: AgentCommandOpts;
  ingress: AgentCommandAdmissionIngress;
  model: string;
  lifecycleGeneration: string;
  sessionStoreRuntime: Awaited<ReturnType<typeof loadSessionStoreRuntime>> | undefined;
  runtime: RuntimeEnv;
  deps: CliDeps;
}) {
  const { prepared, opts, runtime, sessionStoreRuntime } = params;
  const { storePath, sessionKey } = prepared;
  const assertSourceCurrent = () => {
    opts.abortSignal?.throwIfAborted();
    opts.assertSourceCurrent?.();
    assertAgentRunLifecycleGenerationCurrent(params.lifecycleGeneration);
    const current =
      sessionStoreRuntime && storePath && sessionKey
        ? sessionStoreRuntime.loadSessionEntry({
            storePath,
            sessionKey,
            readConsistency: "latest",
          })
        : undefined;
    if (!current || current.sessionId !== prepared.sessionId || current.archivedAt !== undefined) {
      throw new Error("Local supervision source session changed");
    }
  };
  const startedAt = Date.now();
  const supervised = await maybeRunSupervisedLocalRoot({
    prepared,
    opts,
    ingress: params.ingress,
    model: params.model,
    assertCurrent: assertSourceCurrent,
    onError: () =>
      runtime.error("Task supervision reported an error; inspect its task and operation receipts."),
  });
  if (supervised && supervised.result.kind !== "ordinary") {
    const task = supervised.task;
    const text = task
      ? `Task ${task.flowId}: ${task.phase}. ${task.endpoint?.reason ?? "Inspect task status."}`
      : supervised.result.kind === "handled"
        ? supervised.result.message
        : "Task accepted for supervised continuation.";
    const result: Awaited<ReturnType<typeof deliverAgentCommandResult>> = {
      payloads: [{ text, mediaUrl: null }],
      meta: { durationMs: Date.now() - startedAt },
    };
    if (task && task.phase !== "succeeded" && task.phase !== "partial") {
      process.exitCode = 1;
    }
    if (opts.deliver === true) {
      const delivery = await loadDeliveryRuntime();
      return await delivery.deliverAgentCommandResult({
        cfg: prepared.cfg,
        deps: params.deps,
        opts,
        // Keep one supervision JSON envelope, including the delivery owner's
        // result on failure; the shared owner still controls sending and errors.
        runtime: opts.json ? { log: () => {}, error: runtime.error, exit: runtime.exit } : runtime,
        outboundSession: prepared.outboundSession,
        sessionEntry: prepared.sessionEntry,
        payloads: [{ text }],
        result: { meta: result.meta },
        assertDeliveryCurrent: assertSourceCurrent,
        onDeliveryResult: opts.json
          ? (delivered) =>
              runtime.log(
                JSON.stringify({ ...delivered, supervisedTask: task ?? supervised.result }),
              )
          : undefined,
      });
    }
    runtime.log(
      opts.json ? JSON.stringify({ ...result, supervisedTask: task ?? supervised.result }) : text,
    );
    return result;
  }
  return undefined;
}

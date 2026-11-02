import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import { resolveInternalSessionEffectsIdentity } from "../config/sessions/internal-session-key.js";
import { retainPreparedSessionEntryPredicate } from "../config/sessions/session-accessor.sqlite-entry-cache-publication-state.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import {
  composeSessionSourceAssertion,
  type PreparedSessionSourceAuthority,
} from "../config/sessions/session-source-authority.js";
import { readSessionTranscriptAnchorsAsync } from "../config/sessions/session-transcript-anchor-read.js";
import { SessionTranscriptReadFenceError } from "../config/sessions/session-transcript-read-fence.js";
import { withSessionTranscriptReadSource } from "../config/sessions/session-transcript-read-source.js";
import type { TranscriptEntryAnchor } from "../config/sessions/transcript-entry-anchor.js";
import type { InternalSessionEntry, SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import { onGatewayWorkMetricsChanged } from "../infra/gateway-work-metrics-events.js";
import {
  readSqliteDatabaseScopedWriteTokenForPath,
  retainSqliteDatabaseWriteScopesForPath,
  sqliteSessionIdWriteScope,
} from "../infra/sqlite-database-admission.js";
import { assertExistingDatabaseIdentity } from "../infra/sqlite-worker-identity.js";
import { getBackgroundOwnerLane } from "../process/background-work.js";
import {
  getGatewayRestartDrainSignal,
  runWithGatewayDetachedWorkAdmission,
} from "../process/gateway-work-admission.js";
import { SESSION_FORK_SOURCE_TOOL } from "../sessions/input-provenance.js";
import {
  getActiveSessionRunCount,
  isSessionRunActive,
} from "../sessions/session-controller.queries.js";
import { deliveryContextFromSession } from "../utils/delivery-context.read.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
} from "./admitted-run-context.js";
import { resolveAgentDir } from "./agent-scope-config.js";
import { emitInternalRunUsageDiagnostic } from "./internal-run-usage.js";
import type { SessionForkRequester } from "./session-fork-requester.js";
import { SessionManager } from "./sessions/session-manager.js";

/**
 * A background agent run over a bounded copy of one session's conversation, through one
 * completed transcript entry. The fork may call only the listed tools, never writes the source
 * transcript, yields to foreground work, and stops when the source session is reset, replaced
 * or rewritten. Tools see the source through `inputProvenance` (`sourceTool: "session_fork"`).
 */
export type SessionForkRunParams = {
  config: OpenClawConfig;
  /** The completed transcript entry the fork reads through. */
  source: TranscriptEntryAnchor;
  prompt: string;
  tools: readonly string[];
  /** Caller-chosen id, so the caller can find what the fork's tools recorded even when it fails. */
  runId: string;
  /** Owner label for admission, lane and diagnostics, such as `core:skill-workshop`. */
  owner: string;
  model: { provider: string; model: string; authProfileId?: string };
  /** The session's durable workspace, never a throwaway worktree. */
  workspaceDir: string;
  /** The finished turn's requester; its current policy is checked again for the run. */
  requester?: SessionForkRequester;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  /** The caller's own liveness, rechecked with the source fences (for example, a feature switch). */
  assertCallerCurrent?: () => void;
  /** The exact source generation the fork read, reported before the model runs. */
  onSourceAdmitted?: (entry: { sessionId: string; lifecycleRevision?: string | null }) => void;
};

/**
 * Admits a fork before any model call: every fork tool must pass the source session's policy.
 * Returns the session's durable workspace (never a throwaway worktree), or undefined to refuse.
 */
export async function prepareSessionFork(params: {
  config: OpenClawConfig;
  source: Pick<TranscriptEntryAnchor, "agentId" | "sessionKey" | "storePath">;
  tools: readonly string[];
  model: { provider: string; model: string };
  workspaceDir: string;
  requester?: SessionForkRequester;
}): Promise<{ workspaceDir: string } | undefined> {
  const { prepareConversationCapabilityProfile } =
    await import("./conversation-capability-profile.js");
  const { isToolAllowedByPolicies } = await import("./tool-policy-match.js");
  const { mergeAlsoAllowPolicy } = await import("./tool-policy.js");
  const entry = await readSessionEntryReadOnlyInWorker({
    agentId: params.source.agentId,
    sessionKey: params.source.sessionKey,
    storePath: params.source.storePath,
    projection: "list",
  });
  // A managed-worktree session records its durable workspace for every turn entry point.
  const workspaceDir = entry?.worktree?.canonicalWorkspaceDir ?? params.workspaceDir;
  const { policy } = await prepareConversationCapabilityProfile({
    config: params.config,
    sessionKey: params.source.sessionKey,
    sandboxSessionKey: params.source.sessionKey,
    agentId: params.source.agentId,
    ...sessionConversationFacts(entry),
    ...params.requester,
    modelProvider: params.model.provider,
    modelId: params.model.model,
    workspaceDir,
  });
  const policies = [
    mergeAlsoAllowPolicy(policy.profilePolicy, policy.profileAlsoAllow),
    mergeAlsoAllowPolicy(policy.providerProfilePolicy, policy.providerProfileAlsoAllow),
    policy.globalPolicy,
    policy.globalProviderPolicy,
    policy.agentPolicy,
    policy.agentProviderPolicy,
    policy.groupPolicy,
    policy.senderPolicy,
    policy.subagentPolicy,
    policy.inheritedToolPolicy,
  ];
  return params.tools.every((tool) => isToolAllowedByPolicies(tool, policies))
    ? { workspaceDir }
    : undefined;
}

/** The delivery channel a session records; a carried requester takes precedence. */
function sessionConversationFacts(entry: SessionEntry | undefined) {
  const delivery = deliveryContextFromSession(entry);
  return {
    ...(delivery?.channel
      ? { messageChannel: delivery.channel, messageProvider: delivery.channel }
      : {}),
    ...(delivery?.accountId ? { agentAccountId: delivery.accountId } : {}),
  };
}

export type SessionForkOutcome =
  | { ok: true; result: Awaited<ReturnType<typeof runSessionForkInner>> }
  | { ok: false; error: unknown };

/**
 * Runs the fork, then the caller's settlement (for example, announcing what the fork's tools
 * committed) inside the same detached admission, so a graceful restart waits for both.
 */
export async function runSessionFork<T>(
  params: SessionForkRunParams,
  settle: (outcome: SessionForkOutcome) => Promise<T>,
): Promise<T> {
  const abortSignal = params.abortSignal
    ? AbortSignal.any([getGatewayRestartDrainSignal(), params.abortSignal])
    : getGatewayRestartDrainSignal();
  // The foreground root has closed by the time a background owner forks. Admit this detached
  // run independently; a real Gateway drain still refuses it.
  return await runWithGatewayDetachedWorkAdmission(
    async () => {
      let outcome: SessionForkOutcome;
      try {
        outcome = { ok: true, result: await runSessionForkInner(params, abortSignal) };
      } catch (error) {
        outcome = { ok: false, error };
      }
      return await settle(outcome);
    },
    `${params.owner}:session-fork`,
    abortSignal,
  );
}

async function runSessionForkInner(params: SessionForkRunParams, abortSignal: AbortSignal) {
  const { source, config, runId, workspaceDir } = params;
  const { agentId, sessionKey } = source;
  const forkSession = resolveInternalSessionEffectsIdentity({ agentId, runId });
  const writeScopes = [sessionKey, sqliteSessionIdWriteScope(source.sessionId)];
  const readWriteToken = () =>
    readSqliteDatabaseScopedWriteTokenForPath(source.storePath, writeScopes);
  let validatedWriteToken: string | undefined;
  using sourceLifetime: Disposable & {
    entry?: ReturnType<typeof retainPreparedSessionEntryPredicate>;
  } = {
    [Symbol.dispose]() {
      this.entry?.release();
    },
  };

  // Read only a bounded suffix through the completed entry. A fork does not need to repay the
  // entire conversation's token budget for one background task.
  const prepare = async (
    scoped: TranscriptEntryAnchor,
    assertPhysicalCurrent: () => void,
    assertPreparationCurrent: () => void,
    databaseIdentity?: string,
  ) => {
    const sessionManager = await SessionManager.openModelContextAsync(scoped, {
      cwd: workspaceDir,
      through: source,
      limits: { maxBytes: 32_768, maxEvents: 64, toolResultOverflow: "omit" },
      signal: abortSignal,
    });
    assertPreparationCurrent();
    // Deleting, replacing, or resetting the source session must not revive its captured evidence.
    let sourceEntry:
      | Pick<InternalSessionEntry, "sessionId" | "lifecycleRevision" | "permissionMode">
      | undefined;
    await readSessionTranscriptAnchorsAsync(
      scoped,
      { entryIds: [], contextAuthority: true, contextValidation: { through: source } },
      abortSignal,
      (facts) => {
        assertPreparationCurrent();
        const current = facts.contextAuthority?.entry;
        if (current?.sessionId !== source.sessionId) {
          throw new Error("Session fork source session was deleted or replaced.");
        }
        if (facts.contextValidated) {
          sourceEntry = current;
          if (databaseIdentity) {
            sourceLifetime.entry = retainPreparedSessionEntryPredicate({
              databaseIdentity,
              sessionKey,
              entry: current,
              matches: (_before, after) =>
                after?.sessionId === current.sessionId &&
                (after.lifecycleRevision ?? null) === (current.lifecycleRevision ?? null) &&
                after.permissionMode === current.permissionMode,
            });
          }
          validatedWriteToken = readWriteToken();
        }
      },
    );
    if (!sourceEntry) {
      throw new SessionTranscriptReadFenceError("Session transcript changed during context read");
    }
    return { scoped, sourceEntry, sessionManager, assertPhysicalCurrent };
  };
  const { scoped, sourceEntry, sessionManager, assertPhysicalCurrent } =
    await withSessionTranscriptReadSource(
      source,
      ({ scope, expectedIdentity, assertCurrent }) => {
        const assertSourceIdentity = () => {
          abortSignal.throwIfAborted();
          if (expectedIdentity) {
            assertExistingDatabaseIdentity(
              scope.storePath,
              expectedIdentity.key,
              expectedIdentity.birthtime,
            );
          }
        };
        return prepare(
          { ...source, ...scope },
          assertSourceIdentity,
          assertCurrent,
          expectedIdentity?.key,
        );
      },
      abortSignal,
    );
  params.onSourceAdmitted?.({
    sessionId: sourceEntry.sessionId,
    lifecycleRevision: sourceEntry.lifecycleRevision ?? null,
  });
  const assertScopeCurrent = () => {
    assertPhysicalCurrent();
    if (sourceLifetime.entry && !sourceLifetime.entry.isCurrent()) {
      throw new SessionTranscriptReadFenceError("Session fork authority changed");
    }
    params.assertCallerCurrent?.();
  };
  const assertReceiptCurrent = (token: string | undefined) => {
    assertScopeCurrent();
    if (token === undefined || readWriteToken() !== token) {
      throw new SessionTranscriptReadFenceError("Session transcript changed during context read");
    }
  };
  const prepareSource = async (): Promise<PreparedSessionSourceAuthority> => {
    assertScopeCurrent();
    const release = retainSqliteDatabaseWriteScopesForPath(scoped.storePath, writeScopes);
    if (!release) {
      throw new SessionTranscriptReadFenceError("Session fork source is unavailable");
    }
    try {
      if (validatedWriteToken === undefined || readWriteToken() !== validatedWriteToken) {
        // The reader retains writer admission through this callback. Reuse its
        // authority until an owning session or transcript writer publishes a change.
        validatedWriteToken = undefined;
        await readSessionTranscriptAnchorsAsync(
          scoped,
          {
            entryIds: [],
            contextValidation: { through: source, expectedAuthority: sourceEntry },
          },
          abortSignal,
          (facts) => {
            if (facts.contextValidated) {
              validatedWriteToken = readWriteToken();
            }
          },
        );
      }
      const token = validatedWriteToken;
      const assertCurrent = () => assertReceiptCurrent(token);
      assertCurrent();
      return { assertCurrent, checks: [], release };
    } catch (error) {
      release();
      throw error;
    }
  };
  const assertSourceCurrent = composeSessionSourceAssertion([
    Object.assign(
      () => {
        // Model liveness follows admitted entry facts; each effect separately
        // revalidates the completed-turn anchor and retains its exact write receipt.
        assertScopeCurrent();
        if (!sourceLifetime.entry) {
          assertReceiptCurrent(validatedWriteToken);
        }
      },
      {
        assertScopeCurrent,
        prepareSessionSource: prepareSource,
        prepareSessionSourceScope: prepareSource,
      },
    ),
  ]);
  const preparedRunAdmission = prepareAgentRunAdmission({
    cfg: config,
    operationalRunInstance: createOperationalRunInstanceRef(runId),
    facts: {
      runId,
      agentId,
      ingress: { kind: "system", boundary: `${params.owner}.session-fork`, state: "present" },
    },
    assertSourceCurrent,
  });
  const entry = await readSessionEntryReadOnlyInWorker({
    agentId,
    sessionKey,
    storePath: source.storePath,
    projection: "list",
  });
  const agentDir = resolveAgentDir(config, agentId);

  const foreground = new AbortController();
  const yieldToForeground = () => {
    const ownRun = isSessionRunActive(forkSession.sessionId) ? 1 : 0;
    if (getActiveSessionRunCount() > ownRun) {
      foreground.abort(new DOMException("Session fork yielded to foreground work", "AbortError"));
    }
  };
  const unsubscribe = onGatewayWorkMetricsChanged(yieldToForeground);
  const runSignal = AbortSignal.any([abortSignal, foreground.signal]);
  // Background runs stay out of the Control UI and never project into a user session.
  registerAgentRunContext(runId, {
    agentId,
    sessionId: forkSession.sessionId,
    sessionKey: forkSession.sessionKey,
    isControlUiVisible: false,
    projectSessionActive: false,
    projectSessionLifecycle: false,
    projectSessionMessages: false,
  });
  try {
    yieldToForeground();
    runSignal.throwIfAborted();
    const { runEmbeddedAgent } = await import("./embedded-agent.js");
    const result = await runEmbeddedAgent({
      agentId,
      agentDir,
      config,
      preparedRunAdmission,
      sessionId: forkSession.sessionId,
      sessionKey: forkSession.sessionKey,
      // Policy, sandbox and inherited restrictions follow the source conversation.
      sandboxSessionKey: sessionKey,
      sandboxAgentId: agentId,
      ...sessionConversationFacts(entry),
      ...params.requester,
      inputProvenance: {
        kind: "internal_system",
        sourceTool: SESSION_FORK_SOURCE_TOOL,
        sourceSessionKey: sessionKey,
        runId,
      },
      sessionManager,
      workspaceDir,
      permissionMode: sourceEntry.permissionMode,
      abortSignal: runSignal,
      prompt: params.prompt,
      provider: params.model.provider,
      model: params.model.model,
      ...(params.model.authProfileId
        ? { authProfileId: params.model.authProfileId, authProfileIdSource: "user" as const }
        : {}),
      runId,
      lane: getBackgroundOwnerLane(params.owner),
      agentHarnessId: "openclaw",
      agentHarnessRuntimeOverride: "openclaw",
      // Background work never spends interactive capacity on retries or fallbacks.
      modelSelectionLocked: true,
      modelFallbacksOverride: [],
      retryTransientErrors: false,
      allowAuthProfileFallback: false,
      authProfileFailurePolicy: "local_transient",
      requestedRouteResolution: "resolved",
      sessionPersistence: "detached",
      toolsAllow: [...params.tools],
      toolExecutionAllow: [...params.tools],
      codeModeOverride: false,
      disableToolSearch: true,
      promptMode: "minimal",
      bootstrapContextMode: "lightweight",
      forceMessageTool: false,
      contextTokenBudget: 16_384,
      streamParams: { maxTokens: 2_048 },
      thinkLevel: "low",
      timeoutMs: Math.min(params.timeoutMs, 120_000),
      disableTrajectory: true,
      silentExpected: true,
      allowEmptyAssistantReplyAsSilent: true,
      terminalReplyExpectation: "optional",
      cleanupBundleMcpOnRunEnd: true,
      verboseLevel: "off",
    });
    foreground.signal.throwIfAborted();
    emitInternalRunUsageDiagnostic(result, {
      config,
      agentId,
      agentDir,
      sessionId: forkSession.sessionId,
      sessionKey: forkSession.sessionKey,
      provider: params.model.provider,
      model: params.model.model,
    });
    return result;
  } finally {
    unsubscribe();
    preparedRunAdmission.close();
    clearAgentRunContext(runId);
    cleanupSessionResources(forkSession.sessionId);
  }
}

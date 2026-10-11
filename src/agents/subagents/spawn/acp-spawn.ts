import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AcpTurnAttachment } from "../../../acp/control-plane/manager.types.js";
import { cleanupFailedAcpSpawn } from "../../../acp/control-plane/spawn.js";
import { isAcpEnabledByPolicy, resolveAcpAgentPolicyError } from "../../../acp/policy.js";
import {
  validateAcpResumeSessionOwnership,
  withAcpResumeSessionAuthorization,
} from "../../../acp/runtime/session-meta-resume-authorization.js";
import { isExecutionIdentityCollectionEnabled } from "../../../audit/audit-config.js";
import { captureSessionEventTargetForHost as captureSessionEventTarget } from "../../../auto-reply/reply/session-event-handoff.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import {
  buildSessionCreationStamp,
  inheritSessionGitContributorProfileIds,
  resolveDelegatedSessionCreator,
} from "../../../config/sessions/session-entry-provenance.js";
import { readSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import {
  sessionEntryCommitGuardOptions,
  composeSessionSourceAssertion,
  type SessionSourceAssertion,
} from "../../../config/sessions/session-source-authority.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { resolveGatewaySessionStoreTargetInWorker } from "../../../gateway/session-utils-store-worker.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import {
  resolveEventSessionKeyForPolicy,
  resolveEventSessionRoutingPolicy,
} from "../../../infra/event-session-routing.js";
import {
  getSessionBindingService,
  listSessionBindingsBySessionAsync,
  type SessionBindingRecord,
} from "../../../infra/outbound/session-binding-service.js";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import { isIncognitoSessionKey, normalizeOptionalAgentId } from "../../../routing/session-key.js";
import { recordSessionCreated } from "../../../sessions/session-created.js";
import { waitForSessionParticipantRecording } from "../../../sessions/session-participant-recording.js";
import { recordSubagentSpawned } from "../../../sessions/session-state-events.js";
import { resolveSessionAgentId } from "../../agent-scope.js";
import { reserveChildAdmissionSlot } from "../../child-admission.js";
import {
  findAcpUnsupportedInheritedToolAllow,
  findAcpUnsupportedInheritedToolDeny,
  formatAcpInheritedToolAllowError,
  formatAcpInheritedToolDenyError,
  inheritedToolAllowPatch,
  inheritedToolDenyPatch,
} from "../../inherited-tool-deny.js";
import { runSpawnPipeline, type SpawnBackendAdapter } from "../../spawn-pipeline.js";
import {
  mintSpawnSessionKey,
  prepareSpawnThreadBinding,
  resolveSpawnAdmission,
  resolveSpawnMode,
  type PreparedSpawnThreadBinding,
} from "../../spawn-plan.js";
import { resolveSpawnedWorkspaceInheritance } from "../../spawned-context.js";
import type { PreparedSessionPermissionPolicy } from "../../tool-fs-policy.types.js";
import { resolveGatewayToolOperatorSelection } from "../../tools/gateway-caller-context.js";
import { prepareSubagentSessionListReadCache } from "../registry/subagent-registry-state.js";
import { countUntrackedActiveAcpRunsForOwner } from "./acp-spawn-admission.js";
import {
  resolveAcpSpawnBootstrapDeliveryPlan,
  toGatewayImageAttachments,
  type AcpSpawnBootstrapDeliveryPlan,
} from "./acp-spawn-bootstrap-delivery.js";
import { launchAcpChildThroughGateway } from "./acp-spawn-gateway.js";
import {
  startAcpSpawnParentStreamRelay,
  type AcpSpawnParentRelayHandle,
} from "./acp-spawn-parent-stream.js";
import {
  resolveAcpSenderSpawnError,
  resolveAcpSpawnRuntimePolicyError,
} from "./acp-spawn-policy.js";
import {
  resolveAcpSpawnRequesterState,
  readAcpSpawnParentDeliveryContext,
  resolveRequesterInternalSessionKey,
  shouldStreamAcpSpawnToParent,
} from "./acp-spawn-requester.js";
import {
  buildAcpSpawnError,
  buildAcpSpawnFailureResult,
  type SpawnAcpMode,
  type SpawnAcpResult,
} from "./acp-spawn-result.js";
import {
  bindPreparedAcpThread,
  initializeAcpSpawnRuntime,
  resolveAcpSpawnRuntimeOptions,
  resolveRuntimeCwdForAcpSpawn,
  type AcpSpawnInitializedRuntime,
} from "./acp-spawn-runtime.js";
import {
  resolveConfiguredAcpSubagentTargetIds,
  resolveTargetAcpAgentId,
} from "./acp-spawn-target.js";
import { readParentExecutionIdentity } from "./execution-identity-spawn-context.js";
import { captureSpawnParentLineage } from "./spawn-parent-lineage.js";
import {
  isSubagentEnvelopeSession,
  resolveSubagentCapabilityStore,
} from "./subagent-capabilities.js";
import { readGatewayRunId } from "./subagent-spawn-gateway.js";
import { resolveSubagentSpawnOwnership } from "./subagent-spawn-ownership.js";
import { resolveConfiguredSubagentRunTimeoutSeconds } from "./subagent-spawn-plan.js";

type SpawnAcpSandboxMode = "inherit" | "require";

type SpawnAcpParams = {
  task: string;
  taskName?: string;
  label?: string;
  agentId?: string;
  resumeSessionId?: string;
  model?: string;
  thinking?: string;
  runTimeoutSeconds?: number;
  cwd?: string;
  mode?: SpawnAcpMode;
  thread?: boolean;
  sandbox?: SpawnAcpSandboxMode;
  cleanup?: "delete" | "keep";
  expectsCompletionMessage?: boolean;
  streamTo?: "parent";
  attachments?: AcpTurnAttachment[];
};

type SpawnAcpContext = {
  onSpawnEffectsStart?: () => void;
  assertActive?: SessionSourceAssertion;
  agentSessionKey?: string;
  /** Trusted parent tool construction facts; never read from model arguments. */
  senderIsOwner?: boolean;
  expectedParentSessionId?: string;
  requesterTurnRunId?: string;
  completionOwnerKey?: string;
  requesterAgentIdOverride?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  currentMessagingTarget?: string;
  currentChannelId?: string;
  currentMessageId?: string | number;
  /** Group chat ID for channels that distinguish group vs. topic (e.g. Telegram). */
  agentGroupId?: string;
  /** Group space label (guild/team id) from the originating channel context. */
  agentGroupSpace?: string | null;
  /** Trusted provider role ids for the requester in this group turn. */
  agentMemberRoleIds?: string[];
  sandboxed?: boolean;
  inheritedToolAllowlist?: string[];
  inheritedToolDenylist?: string[];
  inheritedToolPolicySource?: "sender";
  workspaceDir?: string;
  sessionPermissionPolicy?: PreparedSessionPermissionPolicy;
};

const ACP_SPAWN_ACCEPTED_NOTE =
  "initial ACP task queued in isolated session; follow-ups continue in the bound thread.";
const ACP_SPAWN_SESSION_ACCEPTED_NOTE =
  "thread-bound ACP session stays active after this task; continue in-thread for follow-ups.";

export async function spawnAcpDirect(
  params: SpawnAcpParams,
  ctx: SpawnAcpContext,
): Promise<SpawnAcpResult> {
  const requester = resolveGatewayToolOperatorSelection();
  const assertSourceActive = requester.operatorAuthority
    ? composeSessionSourceAssertion([ctx.assertActive, requester.assertCurrent])
    : ctx.assertActive;
  const cfg = getRuntimeConfig();
  const runTimeoutSeconds = resolveConfiguredSubagentRunTimeoutSeconds({
    cfg,
    runTimeoutSeconds: params.runTimeoutSeconds,
  });
  const requesterInternalKey = resolveRequesterInternalSessionKey({
    cfg,
    requesterSessionKey: ctx.agentSessionKey,
  });
  if (!isAcpEnabledByPolicy(cfg)) {
    return buildAcpSpawnError(
      "acp_disabled",
      "ACP is disabled by policy (`acp.enabled=false`).",
      "forbidden",
    );
  }
  const streamToParentRequested = params.streamTo === "parent";
  const parentSessionKey = normalizeOptionalString(ctx.agentSessionKey);
  if (streamToParentRequested && !parentSessionKey) {
    return buildAcpSpawnError(
      "requester_session_required",
      'sessions_spawn streamTo="parent" requires an active requester session context.',
    );
  }

  const requestThreadBinding = params.thread === true;
  const requesterAgentId = resolveSessionAgentId({
    config: cfg,
    sessionKey: requesterInternalKey,
    agentId: ctx.requesterAgentIdOverride,
  });
  const runtimePolicyError = resolveAcpSpawnRuntimePolicyError({
    cfg,
    requesterAgentId,
    requesterSessionKey: ctx.agentSessionKey,
    requesterSandboxed: ctx.sandboxed,
    sandbox: params.sandbox,
  });
  if (runtimePolicyError) {
    return buildAcpSpawnError("runtime_policy", runtimePolicyError, "forbidden");
  }
  const acpUnsupportedInheritedTool = findAcpUnsupportedInheritedToolDeny(
    ctx.inheritedToolDenylist,
  );
  if (acpUnsupportedInheritedTool) {
    return buildAcpSpawnError(
      "runtime_policy",
      formatAcpInheritedToolDenyError(acpUnsupportedInheritedTool),
      "forbidden",
    );
  }
  const acpUnsupportedInheritedAllow = findAcpUnsupportedInheritedToolAllow(
    ctx.inheritedToolAllowlist,
  );
  if (acpUnsupportedInheritedAllow) {
    return buildAcpSpawnError(
      "runtime_policy",
      formatAcpInheritedToolAllowError(acpUnsupportedInheritedAllow),
      "forbidden",
    );
  }

  const spawnMode = resolveSpawnMode({
    requestedMode: params.mode,
    threadRequested: requestThreadBinding,
  });
  if (spawnMode === "session" && !requestThreadBinding) {
    return buildAcpSpawnError(
      "thread_required",
      'sessions_spawn(runtime="acp", mode="session") requires thread=true so the ACP session can stay bound to a channel thread. ' +
        'Retry with { mode: "session", thread: true } on a channel that exposes threads (e.g. Discord, Slack, Telegram topics), or use mode="run" for one-shot work.',
    );
  }

  const targetAgentResult = resolveTargetAcpAgentId({
    requestedAgentId: params.agentId,
    cfg,
  });
  if (!targetAgentResult.ok) {
    return buildAcpSpawnError(
      params.agentId && normalizeOptionalAgentId(params.agentId)
        ? "runtime_agent_mismatch"
        : "target_agent_required",
      targetAgentResult.error,
    );
  }
  const { agentId: targetAgentId, configAgentId, backendId } = targetAgentResult;
  const ownerAgentId = configAgentId ?? requesterAgentId;
  const senderRestricted = ctx.inheritedToolPolicySource === "sender";
  const requesterRoot = ctx.sessionPermissionPolicy?.root ?? ctx.workspaceDir;
  const requesterPolicyError = resolveAcpSenderSpawnError({
    ...ctx,
    requesterAgentId,
    targetAgentId,
    cwd: params.cwd,
  });
  if (requesterPolicyError) {
    return buildAcpSpawnError("runtime_policy", requesterPolicyError, "forbidden");
  }
  const agentPolicyError = resolveAcpAgentPolicyError(cfg, targetAgentId);
  if (agentPolicyError) {
    return buildAcpSpawnError("agent_forbidden", agentPolicyError.message, "forbidden");
  }
  const subagentStore = resolveSubagentCapabilityStore(parentSessionKey, {
    cfg,
  });
  const requesterState = await resolveAcpSpawnRequesterState({
    cfg,
    parentSessionKey,
    requesterAgentId,
    ownerAgentId,
    ctx,
    assertActive: assertSourceActive,
  });
  assertSourceActive?.();
  const ownership = resolveSubagentSpawnOwnership({
    cfg,
    agentSessionKey: ctx.agentSessionKey,
    completionOwnerKey: ctx.completionOwnerKey,
  });
  const requesterTarget = await resolveGatewaySessionStoreTargetInWorker({
    cfg,
    key: ownership.completionRequesterSessionKey,
    agentId: ctx.requesterAgentIdOverride,
    assertActive: assertSourceActive,
  });
  assertSourceActive?.();
  const requesterEntry = requesterTarget.store[requesterTarget.canonicalKey];
  const completionRequesterSessionId = requesterEntry?.sessionId;
  const completionRequesterLifecycleRevision = requesterEntry?.lifecycleRevision;
  const hasSubagentEnvelope = isSubagentEnvelopeSession(requesterInternalKey, {
    cfg,
    store: subagentStore,
  });
  await prepareSubagentSessionListReadCache();
  assertSourceActive?.();
  const resolveAdmission = (pendingChildren = 0, pendingChildSessionKeys?: ReadonlySet<string>) =>
    resolveSpawnAdmission({
      cfg,
      inheritedToolPolicySource: ctx.inheritedToolPolicySource,
      enabled: hasSubagentEnvelope || senderRestricted,
      requesterSessionKey: requesterInternalKey,
      requesterAgentId,
      targetAgentId,
      requestedAgentId: params.agentId,
      configuredAgentIds: resolveConfiguredAcpSubagentTargetIds(cfg),
      additionalActiveChildren: hasSubagentEnvelope
        ? countUntrackedActiveAcpRunsForOwner(requesterInternalKey, pendingChildSessionKeys) +
          pendingChildren
        : 0,
    });
  const admission = resolveAdmission();
  if (!admission.ok) {
    return buildAcpSpawnError("subagent_policy", admission.error, "forbidden");
  }
  const resumeOwnership = {
    cfg,
    ownerAgentId,
    runtimeAgentId: targetAgentId,
    backendId,
    requesterSessionKey: requesterInternalKey,
    resumeSessionId: params.resumeSessionId,
    assertCurrent: assertSourceActive,
  };
  const resumeAuthorization = await validateAcpResumeSessionOwnership(resumeOwnership);
  assertSourceActive?.();
  if (!resumeAuthorization.ok) {
    return buildAcpSpawnError("resume_forbidden", resumeAuthorization.error, "forbidden");
  }
  const runtimeOptionsResult = resolveAcpSpawnRuntimeOptions({
    cfg,
    targetAgentId,
    configAgentId: targetAgentResult.configAgentId,
    model: params.model,
    thinking: params.thinking,
    runTimeoutSeconds,
  });
  if (!runtimeOptionsResult.ok) {
    return buildAcpSpawnError("spawn_failed", runtimeOptionsResult.error);
  }
  const effectiveStreamToParent = shouldStreamAcpSpawnToParent({
    spawnMode,
    requestThreadBinding,
    streamToParentRequested,
    requester: requesterState,
  });

  const sessionKey = mintSpawnSessionKey({ targetAgentId: ownerAgentId, backend: "acp" });
  const resolvedCwd = resolveSpawnedWorkspaceInheritance({
    config: cfg,
    targetAgentId: ownerAgentId,
    requesterSessionKey: ctx.agentSessionKey,
    explicitWorkspaceDir: senderRestricted ? requesterRoot : params.cwd,
  });
  let runtimeCwd: string | undefined;
  try {
    runtimeCwd = await resolveRuntimeCwdForAcpSpawn({
      resolvedCwd,
      explicitCwd: senderRestricted ? requesterRoot : params.cwd,
    });
  } catch (error) {
    return buildAcpSpawnError("cwd_resolution_failed", formatErrorMessage(error));
  }

  let preparedBinding: PreparedSpawnThreadBinding | null = null;
  if (requestThreadBinding) {
    const prepared = await prepareSpawnThreadBinding({
      cfg,
      kind: "acp",
      mode: spawnMode,
      bindingService: {
        ...getSessionBindingService(),
        listBySession: listSessionBindingsBySessionAsync,
      },
      channel: requesterState.origin?.channel,
      accountId: requesterState.origin?.accountId,
      to: requesterState.origin?.to,
      threadId: requesterState.origin?.threadId,
      groupId: ctx.agentGroupId,
    });
    assertSourceActive?.();
    if (!prepared.ok) {
      return buildAcpSpawnError("thread_binding_invalid", prepared.error);
    }
    preparedBinding = prepared.binding;
  }

  let childCreationEntry: SessionEntry | undefined;
  let closeRuntimeOnFailure: (() => Promise<void>) | undefined;
  const childIdem = crypto.randomUUID();
  // Resolve parent session delivery context so system events route to the
  // correct thread/topic instead of falling back to the main DM.
  const parentDeliveryCtx =
    effectiveStreamToParent && parentSessionKey
      ? await readAcpSpawnParentDeliveryContext({
          parentSessionKey,
          requesterAgentId,
          assertActive: assertSourceActive,
        })
      : undefined;
  assertSourceActive?.();

  const parentRelayStateEnv = { ...process.env };
  const parentEventRouting = parentSessionKey
    ? resolveEventSessionRoutingPolicy({ cfg, sessionKey: parentSessionKey })
    : undefined;
  const parentEventTarget =
    effectiveStreamToParent && parentSessionKey && parentEventRouting
      ? await captureSessionEventTarget(
          requesterAgentId,
          resolveEventSessionKeyForPolicy(parentSessionKey, parentEventRouting),
        )
      : undefined;
  assertSourceActive?.();
  const gatewayAttachments = toGatewayImageAttachments(params.attachments);
  const requesterOrigin = requesterState.origin;
  const progressOrigin = {
    channel: requesterOrigin?.channel,
    accountId: requesterOrigin?.accountId,
    to: ctx.currentMessagingTarget ?? ctx.currentChannelId ?? requesterOrigin?.to,
    threadId: requesterOrigin?.threadId,
    channelId: ctx.currentChannelId,
    messageId: ctx.currentMessageId,
  };
  type AcpBackendState = {
    initializedSession: AcpSpawnInitializedRuntime;
    binding: SessionBindingRecord | null;
    deliveryPlan?: AcpSpawnBootstrapDeliveryPlan;
    parentRelay?: AcpSpawnParentRelayHandle;
  };
  const adapter: SpawnBackendAdapter<AcpBackendState> = {
    async initialize() {
      const parentTarget = await resolveGatewaySessionStoreTargetInWorker({
        cfg,
        key: requesterInternalKey,
        agentId: requesterAgentId,
        assertActive: assertSourceActive,
      });
      const parentStorePath = parentTarget.readSource?.path ?? parentTarget.storePath;
      await waitForSessionParticipantRecording({
        agentId: requesterAgentId,
        sessionKey: parentTarget.canonicalKey,
        storePath: parentStorePath,
      });
      assertSourceActive?.();
      const readParentEntry = () =>
        readSessionEntryReadOnlyInWorker(
          {
            agentId: requesterAgentId,
            sessionKey: parentTarget.canonicalKey,
            storePath: parentStorePath,
          },
          () => assertSourceActive?.(),
        );
      const parentEntry = isIncognitoSessionKey(requesterInternalKey)
        ? undefined
        : await readParentEntry();
      // Incognito parents are never read here, so like rowless parents they record no incarnation.
      const parentLineage = captureSpawnParentLineage({
        parentEntry,
        expectedParentSessionId: ctx.expectedParentSessionId,
        senderIsOwner: ctx.senderIsOwner,
        readParentEntry,
      });
      const creationStamp = buildSessionCreationStamp({
        via: "spawn",
        actor: resolveDelegatedSessionCreator(
          parentEntry,
          { type: "agent", id: requesterAgentId },
          requester.operatorAuthority?.profileId,
        ),
        inheritedGitContributorProfileIds: inheritSessionGitContributorProfileIds(parentEntry),
      });
      const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: ownerAgentId });
      const childSessionPatch = admission.childSessionPatch
        ? {
            spawnDepth: admission.childSessionPatch.spawnDepth,
            ...(admission.childSessionPatch.subagentRole
              ? { subagentRole: admission.childSessionPatch.subagentRole }
              : {}),
            subagentControlScope: admission.childSessionPatch.subagentControlScope,
          }
        : {};
      await parentLineage.assertParentUnchanged();
      assertSourceActive?.();
      childCreationEntry =
        (await upsertSessionEntryCore(
          { storePath, sessionKey, agentId: ownerAgentId },
          {
            ...creationStamp,
            spawnedBy: requesterInternalKey,
            spawnedByAgentId: requesterAgentId,
            completionOwnerSessionKey: ownership.completionRequesterSessionKey,
            // Navigation parent is stamped at creation so the durable tree edge
            // does not depend on the control-lineage field.
            parentSessionKey: requesterInternalKey,
            ...childSessionPatch,
            inheritedToolPolicyVersion: 1,
            ...(ctx.inheritedToolPolicySource
              ? { inheritedToolPolicySource: ctx.inheritedToolPolicySource }
              : {}),
            ...inheritedToolAllowPatch(ctx.inheritedToolAllowlist),
            ...inheritedToolDenyPatch(ctx.inheritedToolDenylist),
            ...(senderRestricted
              ? {
                  spawnedWorkspaceDir: ctx.workspaceDir ?? requesterRoot,
                  spawnedCwd: runtimeCwd,
                  sessionRoot: requesterRoot,
                  permissionMode: ctx.sessionPermissionPolicy?.mode,
                }
              : {}),
            ...(params.label ? { label: params.label } : {}),
            // Same trust rules as native spawn: stamped last, from trusted host facts only.
            ...parentLineage.receipt,
          },
          sessionEntryCommitGuardOptions(assertSourceActive),
        )) ?? undefined;
      const initializedSession = await withAcpResumeSessionAuthorization(
        resumeOwnership,
        (revalidateResume) =>
          initializeAcpSpawnRuntime({
            assertActive: assertSourceActive,
            revalidateResume,
            cfg,
            sessionKey,
            ownerAgentId,
            runtimeAgentId: targetAgentId,
            runtimeMode: spawnMode === "session" ? "persistent" : "oneshot",
            backendId,
            resumeSessionId: params.resumeSessionId,
            runtimeOptions: runtimeOptionsResult.runtimeOptions,
            modelExplicit: runtimeOptionsResult.modelExplicit,
            thinkingExplicit: runtimeOptionsResult.thinkingExplicit,
            cwd: runtimeCwd,
          }),
      );
      closeRuntimeOnFailure = initializedSession.initialized.closeRuntimeOnFailure;
      assertSourceActive?.();
      const binding = preparedBinding
        ? await bindPreparedAcpThread({
            assertActive: assertSourceActive,
            cfg,
            sessionKey,
            targetAgentId: ownerAgentId,
            label: params.label,
            preparedBinding,
            initializedRuntime: initializedSession,
          })
        : null;
      return { initializedSession, binding };
    },
    async dispatchTurn(state) {
      state.deliveryPlan = resolveAcpSpawnBootstrapDeliveryPlan({
        cfg,
        spawnMode,
        effectiveStreamToParent,
        requester: requesterState,
        binding: state.binding,
      });
      // ACP bypasses the native adapter, so seed the same child lineage before dispatch.
      if (childCreationEntry) {
        await recordSessionCreated(cfg, {
          sessionKey,
          agentId: ownerAgentId,
          entry: childCreationEntry,
        });
      }
      await recordSubagentSpawned({
        childSessionKey: sessionKey,
        childRunId: childIdem,
        requesterSessionKey: requesterInternalKey,
        agentId: ownerAgentId,
      });
      const startParentRelay = (runId: string) =>
        effectiveStreamToParent && parentSessionKey && parentEventRouting && parentEventTarget
          ? startAcpSpawnParentStreamRelay({
              runId,
              parentSessionKey,
              requesterAgentId,
              expectedTarget: parentEventTarget,
              childSessionKey: sessionKey,
              childSessionId: state.initializedSession.sessionId,
              agentId: targetAgentId,
              ownerAgentId,
              env: parentRelayStateEnv,
              eventRouting: parentEventRouting,
              deliveryContext: parentDeliveryCtx,
              cfg,
            })
          : undefined;
      state.parentRelay = startParentRelay(childIdem);
      const response = await launchAcpChildThroughGateway({
        assertDispatchCurrent: assertSourceActive,
        task: params.task,
        sessionKey,
        deliveryPlan: state.deliveryPlan,
        childIdem,
        runTimeoutSeconds,
        label: params.label,
        attachments: gatewayAttachments,
        lineage: {
          enabled: isExecutionIdentityCollectionEnabled(cfg),
          backend: "acp",
          parentAgentId: requesterAgentId,
          requesterRef: requesterInternalKey,
          controllerRef: ownership.controllerSessionKey,
          depth: admission.childSessionPatch?.spawnDepth ?? 1,
          maxDepth: admission.maxSpawnDepth,
          targetAgentId: ownerAgentId,
          sandbox: params.sandbox === "require" ? "require" : "inherit",
          inheritedToolAllowlist: ctx.inheritedToolAllowlist,
          inheritedToolDenylist: ctx.inheritedToolDenylist,
        },
        parentExecutionIdentityToken: readParentExecutionIdentity(ctx),
        participantStorePath: resolveSessionStorePathCore(cfg.session?.store, {
          agentId: ownerAgentId,
        }),
      });
      const runId = readGatewayRunId(response) ?? childIdem;
      if (state.parentRelay && runId !== childIdem) {
        // Seal the old relay now; its Gateway owner joins diagnostic settlement.
        void state.parentRelay.dispose();
        state.parentRelay = startParentRelay(runId);
      }
      state.parentRelay?.notifyStarted();
      return { runId };
    },
    async cleanupOnFailure({ state }) {
      await state?.parentRelay?.dispose();
      await cleanupFailedAcpSpawn({
        cfg,
        sessionKey,
        agentId: ownerAgentId,
        sessionEntry: childCreationEntry,
        deleteTranscript: true,
        closeRuntimeOnFailure,
      });
    },
  };
  const { controllerSessionKey } = ownership;
  assertSourceActive?.();
  const admissionReservation = hasSubagentEnvelope
    ? reserveChildAdmissionSlot({
        controllerSessionKey,
        childSessionKey: sessionKey,
        resolveAdmission,
      })
    : undefined;
  if (admissionReservation && !admissionReservation.ok) {
    return buildAcpSpawnError("subagent_policy", admissionReservation.error, "forbidden");
  }
  // Admission may already hold a slot; initialization and cleanup can mutate session state.
  ctx.onSpawnEffectsStart?.();
  let expectsCompletionMessage = false;
  const pipelineResult = await runSpawnPipeline({
    adapter,
    assertActive: assertSourceActive,
    admissionReservation,
    hookRunner: getGlobalHookRunner(),
    progressOrigin,
    progressSessionKey: ownership.completionRequesterSessionKey,
    buildRegistration: (state, runId) => {
      const inlineDelivery = state.deliveryPlan?.useInlineDelivery === true;
      expectsCompletionMessage = !inlineDelivery && params.expectsCompletionMessage !== false;
      return {
        runId,
        requesterTurnRunId: ctx.requesterTurnRunId,
        childSessionKey: sessionKey,
        controllerSessionKey,
        sessionEntry: state.initializedSession.sessionEntry,
        requesterSessionKey: ownership.completionRequesterSessionKey,
        completionRequesterSessionId,
        completionRequesterLifecycleRevision,
        requesterOrigin,
        progressOrigin,
        requesterDisplayKey: ownership.completionRequesterDisplayKey,
        task: params.task,
        taskName: params.taskName,
        agentId: ownerAgentId,
        requesterAgentId,
        cleanup: spawnMode === "session" ? "keep" : params.cleanup === "delete" ? "delete" : "keep",
        label: params.label,
        runTimeoutSeconds,
        expectsCompletionMessage,
        spawnMode,
        // ACP's Gateway manager publishes the task; avoid a second registry projection.
      };
    },
  });
  if (!pipelineResult.ok) {
    return buildAcpSpawnFailureResult(pipelineResult, sessionKey);
  }
  return {
    status: "accepted",
    childSessionKey: sessionKey,
    runId: pipelineResult.runId,
    mode: spawnMode,
    runTimeoutSeconds,
    expectsCompletionMessage,
    ...(pipelineResult.state.deliveryPlan?.useInlineDelivery ? { inlineDelivery: true } : {}),
    note: spawnMode === "session" ? ACP_SPAWN_SESSION_ACCEPTED_NOTE : ACP_SPAWN_ACCEPTED_NOTE,
  };
}

import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/io.js";
import { updateSessionGoalStatus } from "../../config/sessions/goals.js";
import {
  loadSessionEntry,
  readSessionPendingInput,
} from "../../config/sessions/session-accessor.js";
import { projectPublicSessionEntry } from "../../config/sessions/session-entry-projection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { captureGatewayAuthPolicy } from "../../gateway/auth-policy.js";
import { createChatAbortOps } from "../../gateway/chat-abort-ops.js";
import { abortChatRunById } from "../../gateway/chat-abort.js";
import {
  captureGatewayDeviceRevocation,
  readGatewayDeviceRecoverySource,
} from "../../gateway/device-revocation.js";
import { captureGatewayOperatorRunAuthority } from "../../gateway/operator-run-authority.js";
import { createGatewayInstanceRuntime } from "../../gateway/server-instance-runtime.js";
import { createRequestGatewayMethodRegistry } from "../../gateway/server-methods.js";
import { createOperatorClient } from "../../gateway/server-plugin-in-process-dispatch.test-support.js";
import { createGatewayRequestContext } from "../../gateway/server-request-context.js";
import { makeContextParams } from "../../gateway/server-request-context.test-support.js";
import { SharedGatewaySessionGenerationState } from "../../gateway/server-shared-auth-generation.js";
import { prepareGatewayOperatorIngressMetadata } from "../../gateway/server/ws-connection/connect-device-metadata.js";
import { readSessionMessagesAsync } from "../../gateway/session-transcript-readers.js";
import { approveDevicePairing } from "../../infra/device-pairing-approval.js";
import { getPublishedOperatorPairingIdentity } from "../../infra/device-pairing-publication.js";
import { requestDevicePairing, getPairedDevice } from "../../infra/device-pairing.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { stageActivePluginRegistry } from "../../plugins/runtime.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { buildRunUserTurnIdempotencyKey } from "../../sessions/user-turn-transcript.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import { prepareUserProfileIdentity } from "../../state/user-profile-list.js";
import {
  ensureCanonicalFactoryGitHubProfile,
  setCanonicalUserProfileRole,
} from "../../state/user-profile-writes.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readOperatorModelPolicyCeilings } from "../operator-model-policy.js";
import { refreshPreparedModelRuntimeSnapshots } from "../prepared-model-runtime.js";
import { withGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import { createCreateGoalTool } from "../tools/goal-tools.js";

export const legacyIssuerChanges = [
  "current",
  "current grant",
  "terminal error",
  "budget exhausted",
  "forged only",
  "uncaptured issuer",
  "manual pause",
  "cancel",
  "complete",
  "goal changed",
  "SID changed",
  "lifecycle changed",
  "role revoked",
  "commit role revoke",
  "late role revoke",
  "model revoked",
  "source role broadened",
  "auth changed",
  "shared changed",
  "verification unavailable",
  "grant ended",
  "grant unavailable",
  "token rotated same time",
  "device removed",
  "alias moved",
  "unknown effect",
] as const;
export const acceptedTurnChanges = [
  "current grant",
  "missing factory actor",
  "cancel",
  "complete",
  "manual pause",
  "unknown effect",
  "role revoked",
  "device removed",
  "alias moved",
  "grant ended",
  "grant unavailable",
  "SID changed",
  "lifecycle changed",
  "actor mismatch",
  "wrong repository",
  "late role revoke",
  "late repository replaced",
] as const;

export async function createOriginalIssuerFixture(
  state: OpenClawTestState,
  index: number,
  change: string,
  nativeCodex = false,
  sharedHost?: {
    cfg: OpenClawConfig;
    registry: ReturnType<typeof createEmptyPluginRegistry>;
    work: AsyncWorkScope;
    context: ReturnType<typeof createGatewayRequestContext>;
    runtime: ReturnType<typeof createGatewayInstanceRuntime>;
    methods: ReturnType<typeof createRequestGatewayMethodRegistry>;
    grant: { grantId: string; assertCurrent: () => void; signal: AbortSignal };
    usesGrant: boolean;
  },
  sharedSessionWrite = false,
) {
  const profile = await ensureCanonicalFactoryGitHubProfile(
    `github:microsoft.ghe.com:${700100 + index}`,
    "Issuer fixture",
    {},
    { login: `issuer-${index}`, email: `issuer-${index}@example.test` },
  );
  await setCanonicalUserProfileRole(profile.id, "engineer");
  const modelProvider = nativeCodex ? "openai" : "fixture";
  const cfg: OpenClawConfig = sharedHost?.cfg ?? {
    agents: {
      defaults: {
        workspace: state.workspaceDir,
        skipBootstrap: true,
        model: `${modelProvider}/allowed`,
        ...(nativeCodex ? { models: { "openai/allowed": { agentRuntime: { id: "codex" } } } } : {}),
      },
      entries: { main: {} },
    },
    models: {
      mode: "replace",
      providers: {
        [modelProvider]: {
          baseUrl: nativeCodex ? "https://api.openai.com/v1" : "http://127.0.0.1:1/v1",
          api: "openai-responses",
          apiKey: "synthetic-fixture-key",
          models: [
            {
              id: "allowed",
              name: "Fixture",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 16000,
              maxTokens: 1000,
            },
          ],
        },
      },
    },
    gateway: {
      github: { host: "microsoft.ghe.com", apiBaseUrl: "https://api.microsoft.ghe.com" },
      auth: { mode: "trusted-proxy", trustedProxy: { userHeader: "x-factory-principal" } },
      roles: {
        default: "engineer",
        definitions: {
          engineer: {
            scopes: ["operator.read", "operator.write"],
            sessions: { others: sharedSessionWrite ? "write" : "none" },
            agents: ["main"],
            modelPolicy: { allow: [`${modelProvider}/allowed`] },
          },
        },
      },
    },
    plugins: {
      enabled: nativeCodex,
      slots: { memory: "none" },
      ...(nativeCodex ? { entries: { codex: { enabled: true } } } : {}),
    },
    tools: { exec: { security: "full", ask: "off" } },
  };
  if (!sharedHost) {
    await state.writeConfig(cfg);
  }
  setRuntimeConfigSnapshot(cfg);
  let grantState: "current" | "ended" | "unavailable" = "current";
  const registry = sharedHost?.registry ?? createEmptyPluginRegistry();
  const usesGrant =
    sharedHost?.usesGrant ??
    (change === "current grant" || change === "grant ended" || change === "grant unavailable");
  const grant = sharedHost?.grant ?? {
    grantId: `issuer-grant-${index}`,
    assertCurrent: () => {},
    signal: new AbortController().signal,
  };
  const resumeGrant = vi.fn(() => {
    if (grantState === "unavailable") {
      throw new Error("Synthetic unavailable policy");
    }
    return grantState === "ended" ? undefined : grant;
  });
  if (usesGrant && !sharedHost) {
    registry.plugins.push(createPluginRecord({ id: "issuer-access" }));
    registry.gatewayAccessPolicies.push({
      pluginId: "issuer-access",
      source: "fixture",
      policy: {
        authorize: () => grant,
        resume: resumeGrant,
      },
    });
  }
  if (!sharedHost) {
    stageActivePluginRegistry(registry, `issuer-${index}`, "default", state.workspaceDir);
  }
  const shared = new SharedGatewaySessionGenerationState({
    current: "original-shared",
    required: null,
  });
  const work = sharedHost?.work ?? new AsyncWorkScope();
  const contextParams = makeContextParams({
    connectionWork: { track: (run) => work.track(run) },
    sharedGatewaySessionGenerationState: shared,
  });
  const context = sharedHost?.context ?? createGatewayRequestContext(contextParams);
  context.getRuntimeConfig = () => cfg;
  context.getCommittedRuntimeConfig = () => cfg;
  context.resolveGatewayContext = () => context;
  const methods = sharedHost?.methods ?? createRequestGatewayMethodRegistry();
  context.getGatewayMethodRegistry = () => methods;
  const runtime =
    sharedHost?.runtime ??
    createGatewayInstanceRuntime({
      getContext: () => context,
      getMethodRegistry: () => methods,
      isDispatchAvailable: () => true,
    });
  context.recoveryRuntime = runtime.recovery;
  context.createAgentTurnFacade = runtime.createAgentTurnFacade;
  const deviceId = `issuer-device-${index}`;
  const pending = await requestDevicePairing({
    deviceId,
    publicKey: `fixture-public-key-${index}`,
    role: "operator",
    scopes: ["operator.read"],
  });
  const approved = await approveDevicePairing(pending.request.requestId, {
    callerScopes: ["operator.admin"],
  });
  expect(approved?.status, "canonical fixture pairing approval").toBe("approved");
  const originalPairing = await getPairedDevice(deviceId);
  const client = createOperatorClient({
    profileId: profile.id,
    scopes: ["operator.read", "operator.write"],
  });
  client.connect.device = {
    id: deviceId,
    publicKey: `fixture-public-key-${index}`,
    signature: "synthetic",
    signedAt: Date.now(),
    nonce: "synthetic",
  };
  client.authenticatedFactoryGitHubAccountId = 700100 + index;
  client.authenticatedUserId = `github:microsoft.ghe.com:${700100 + index}`;
  client.authPolicy = captureGatewayAuthPolicy(cfg, {
    role: "operator",
    verifiedIdentity: client.authenticatedUserId,
    authMethod: "trusted-proxy",
  });
  client.internal = {
    ...prepareGatewayOperatorIngressMetadata({
      role: "operator",
      authMethod: "trusted-proxy",
      clientId: client.connect.client.id,
      scopes: client.connect.scopes ?? [],
      operatorPairingIdentity: getPublishedOperatorPairingIdentity(deviceId) ?? undefined,
    }),
    operatorAccessAuthority: usesGrant
      ? {
          ...grant,
          gatewayAccessGrant: { pluginId: "issuer-access", grantId: grant.grantId },
        }
      : null,
  };
  const sharedDependency = change === "shared changed" || change === "verification unavailable";
  const deviceSource = captureGatewayDeviceRevocation(
    context,
    { deviceId, role: "operator" },
    () => true,
    undefined,
    {
      isCurrent: () => true,
      subscribe: () => () => {},
      dependencies: {
        client,
        context,
        authPolicyGeneration: client.authPolicy.grantGeneration,
        ...(sharedDependency
          ? { sharedGenerationOwner: shared, sharedGeneration: "original-shared" }
          : {}),
      },
    },
  );
  const original = await captureGatewayOperatorRunAuthority({
    client,
    context,
    hasCurrentClientAuthority: deviceSource.isCurrent,
  });
  expect(original).toBeDefined();
  const preparedIdentity = await prepareUserProfileIdentity(profile.id);
  try {
    expect(
      {
        factory: process.env.FACTORY_AUTH_MODE,
        dependency: Boolean(readGatewayDeviceRecoverySource(deviceSource.isCurrent)?.deviceId),
        pairing: Boolean(client.internal.operatorPairingIdentity),
        aliases: preparedIdentity.emailBindingIds.length > 0,
        models: readOperatorModelPolicyCeilings(original!.authority.modelPolicy) !== undefined,
        grantClassified: original!.authority.gatewayAccessGrant !== undefined,
      },
      "issuer prerequisite classification",
    ).toEqual({
      factory: "github",
      dependency: true,
      pairing: true,
      aliases: true,
      models: true,
      grantClassified: true,
    });
  } finally {
    preparedIdentity.release();
  }
  expect(
    original!.authority.captureRestartRecoveryIssuer?.(),
    "original host issuer basis",
  ).toMatchObject({ version: 1, profileId: profile.id });
  return {
    profile,
    registry,
    cfg,
    grant,
    usesGrant,
    resumeGrant,
    work,
    context,
    runtime,
    methods,
    deviceId,
    originalPairing,
    client,
    deviceSource,
    original,
    changeGrant: (next: "current" | "ended" | "unavailable") => {
      grantState = next;
    },
  };
}

/** Exercise the actual original public admission before any restart fixture mutation. */
export async function acceptOriginalIssuerTurn(
  fixture: Awaited<ReturnType<typeof createOriginalIssuerFixture>>,
  target: { agentId: string; sessionKey: string },
  sessionId: string,
  runId: string,
  workspaceId: string,
  actorId: number,
  goalId?: string,
) {
  const { client, original, runtime, cfg, profile } = fixture;
  const internal = expectDefined(client.internal, "original authenticated connection metadata");
  internal.operatorRunAuthority = original!.authority;
  await refreshPreparedModelRuntimeSnapshots(cfg, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
  const facade = await runtime.createAgentTurnFacade({ client });
  const accepted = await facade.dispatch({
    ...target,
    sessionId,
    message: "Continue the accepted fixture without a goal",
    idempotencyKey: runId,
    deliver: false,
  });
  expect(accepted).toMatchObject({ status: "accepted", runId });
  const saved = loadSessionEntry(target)!;
  expect(saved.goal?.id).toBe(goalId);
  expect(saved.mainRestartRecovery?.turnIntent).toMatchObject({
    runId,
    sessionKey: target.sessionKey,
    sessionId,
    repositoryWorkspaceId: workspaceId,
    issuer: {
      profileId: profile.id,
      factoryActor: { host: "microsoft.ghe.com", accountId: actorId },
    },
  });
  expect(projectPublicSessionEntry(saved)).not.toHaveProperty("mainRestartRecovery");
  const preparing = await readIssuerFixtureHistory(target, sessionId);
  expect(
    preparing.some(
      (message) =>
        isRecord(message) && message.idempotencyKey === buildRunUserTurnIdempotencyKey(runId),
    ),
  ).toBe(false);
}

export function interruptOriginalNoGoalTurn(
  fixture: Awaited<ReturnType<typeof createOriginalIssuerFixture>>,
  target: { agentId: string; sessionKey: string },
  runId: string,
) {
  expect(
    abortChatRunById(createChatAbortOps(fixture.context), {
      runId,
      sessionKey: target.sessionKey,
      stopReason: "restart",
    }).aborted,
  ).toBe(true);
}

export async function pauseNewGoalDuringOriginalDrain(
  fixture: Awaited<ReturnType<typeof createOriginalIssuerFixture>>,
  target: { agentId: string; sessionKey: string },
) {
  const tool = createCreateGoalTool({
    agentSessionKey: target.sessionKey,
    sessionAgentId: target.agentId,
    config: fixture.cfg,
  });
  await withGatewayToolCallerIdentity(
    {
      ...target,
      operatorAuthority: fixture.original!.authority,
      gatewayContextResolver: () => fixture.context,
    },
    () => tool.execute!("new-human-goal", { objective: "Human paused follow-up" }),
  );
  await updateSessionGoalStatus({ ...target, status: "paused" });
}

export async function assertInterruptedOriginalInput(target: {
  agentId: string;
  sessionKey: string;
}) {
  const entry = expectDefined(loadSessionEntry(target), "original accepted session");
  const intent = expectDefined(entry.mainRestartRecovery?.turnIntent, "original accepted issuer");
  expect(
    await readSessionPendingInput({ ...target, sessionId: entry.sessionId }, intent.inputId),
  ).toMatchObject({
    id: intent.inputId,
    runId: intent.runId,
    state: "interrupted",
  });
}

export function readIssuerFixtureHistory(
  target: { agentId: string; sessionKey: string },
  sessionId: string,
) {
  return readSessionMessagesAsync(
    { ...target, sessionId },
    { mode: "recent", maxMessages: 20, maxBytes: 65536 },
  );
}

export async function assertRecoveredOriginalInput(
  target: { agentId: string; sessionKey: string },
  sessionId: string,
  runId: string,
) {
  const messages = await readIssuerFixtureHistory(target, sessionId);
  const originals = messages.filter(
    (message) =>
      isRecord(message) && message.idempotencyKey === buildRunUserTurnIdempotencyKey(runId),
  );
  expect(originals).toHaveLength(1);
  expect(originals[0]).toMatchObject({
    role: "user",
    content: "Continue the accepted fixture without a goal",
  });
}

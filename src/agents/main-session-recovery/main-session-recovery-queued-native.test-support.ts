import fs from "node:fs/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, type Mock } from "vitest";
import { prepareGoalRecoveryNativeFixture } from "../../gateway/server-methods/session-goal-recovery-native.test-support.js";
import { prepareRepositoryWorkerProjectSource } from "../../gateway/worker-environments/repository-project-admission.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { buildRunUserTurnIdempotencyKey } from "../../sessions/user-turn-transcript.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { makeAttemptResult } from "../embedded-agent-runner/run.overflow-compaction.fixture.js";
import type { AgentHarnessV2 } from "../harness/types.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { getGatewayToolCallerIdentity } from "../tools/gateway-caller-context.js";
import { installFactoryRestartRepositoryFixture } from "./main-session-recovery-factory-read.test-support.js";
import {
  type createOriginalIssuerFixture,
  readIssuerFixtureHistory,
} from "./main-session-recovery-original-issuer.test-support.js";

type NativeQueuedParams = Parameters<typeof prepareQueuedNativeRecoveryFixture>[0];
export const freshNativeRecoveryChanges = [
  "native failed before selection",
  "native failed mapping changed",
  "native destroyed before activation",
] as const;
export const queuedRecoveryChanges = [
  "current",
  "new acceptance after legacy head",
  "native",
  "native pending reclaim",
  "native-cancel",
  "readmitted follower",
  "cancel exact",
  "cancel own session",
  "missing capture",
  "malformed current capture",
  "forged actor",
  "nonhuman capture",
  "revoked follower",
  "device revoked",
  "ended grant",
  "unavailable grant",
  "stale SID",
  "stale lifecycle",
  "stale repository",
  "unknown effect",
  "manual pause",
  "late revoke",
] as const;
type QueuedNative = Awaited<ReturnType<typeof prepareQueuedNativeRecoveryFixture>>;

export async function prepareQueuedNativeFixtureOwner(
  params: Omit<NativeQueuedParams, "repositoryProof" | "beforeFirstEffect" | "nativeAttempt"> & {
    nativeCase: boolean;
    repositoryUrl: string;
    nativeAttempt?: NativeQueuedParams["nativeAttempt"];
    mappingChanged: boolean;
    afterLookup: () => Promise<void>;
  },
) {
  let freshInputs = false;
  const firstNativeStarted = createDeferredCore();
  const releaseFirstNative = createDeferredCore();
  const repositoryProof = installFactoryRestartRepositoryFixture({
    ...(params.failedBeforeSelection
      ? {
          allowPublicationPreflight: true as const,
          repositorySnapshot: () => native?.failedRecovery?.repositorySnapshot,
        }
      : {}),
    binding: () => {
      const source =
        getGatewayToolCallerIdentity()?.operatorAuthority ??
        getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority;
      const index = freshInputs
        ? params.issuers.findIndex(
            (issuer) =>
              issuer.profile.id === expectDefined(source, "fresh original broker caller").profileId,
          )
        : params.executionIndexes[params.effects.length]!;
      return {
        ...params.target,
        sessionId: params.sessionId,
        repositoryUrl: params.repositoryUrl,
        context: params.getBrokerContext(),
        actorId: 700100 + index,
        profileId: expectDefined(params.issuers[index], "original broker issuer").profile.id,
      };
    },
    broker: () => "current",
    afterLookup: async () => {
      if (
        params.mappingChanged &&
        freshInputs &&
        native?.placements.get(params.sessionId)?.state === "requested"
      ) {
        const mappings = params.first.cfg.cloudWorkers!.projectProfiles!;
        delete mappings[Object.keys(mappings)[0]!];
      }
      await params.afterLookup();
    },
  });
  const native = params.nativeCase
    ? await prepareQueuedNativeRecoveryFixture({
        ...params,
        repositoryProof,
        nativeAttempt: expectDefined(params.nativeAttempt, "native queued model leaf"),
        ...(params.failedBeforeSelection
          ? {
              beforeFirstEffect: async () => {
                firstNativeStarted.resolve();
                await releaseFirstNative.promise;
              },
            }
          : {}),
      })
    : undefined;
  return {
    native,
    repositoryProof,
    firstNativeStarted,
    releaseFirstNative,
    beginFresh: () => {
      freshInputs = true;
    },
  };
}

export async function exerciseFreshQueuedNativeFixture(
  params: Pick<
    NativeQueuedParams,
    "first" | "target" | "sessionId" | "requests" | "issuers" | "effects"
  > & {
    native: QueuedNative;
    repositoryProof: ReturnType<typeof installFactoryRestartRepositoryFixture>;
    firstNativeStarted: { promise: Promise<void> };
    releaseFirstNative: { resolve: () => void };
    completed: { promise: Promise<void> };
    attemptedRuns: string[];
    attemptErrors: unknown[];
    mappingChanged: boolean;
  },
) {
  const {
    first,
    target,
    sessionId,
    requests,
    issuers,
    effects,
    native,
    repositoryProof,
    firstNativeStarted,
    releaseFirstNative,
    completed,
    attemptedRuns,
    attemptErrors,
    mappingChanged,
  } = params;
  const facades = [];
  try {
    for (const [index, issuer] of issuers.entries()) {
      issuer.client.internal!.operatorRunAuthority = issuer.original!.authority;
      const facade = await first.runtime.createAgentTurnFacade({ client: issuer.client });
      facades.push(facade);
      await expect(
        facade.dispatch({
          ...target,
          sessionId,
          message: requests[index]!.text,
          idempotencyKey: requests[index]!.runId,
          deliver: false,
        }),
      ).resolves.toMatchObject({ status: "accepted", runId: requests[index]!.runId });
      if (mappingChanged) {
        await completed.promise;
        await first.work.runWhenIdle(() => {});
        expect(effects).toEqual([]);
        expect(native!.credentialErrors()).toContain(
          "Unallocated worker recovery repository profile changed",
        );
        expect(attemptErrors).toEqual([
          "The effective GitHub identity could not be verified; retry or reconnect the agent's GitHub identity.",
        ]);
        expect(native!.coldAllocations()).toBe(0);
        expect(native!.redispatches()).toBe(0);
        expect(native!.warmEnvironment()?.preparation?.consumedAtMs).toBeNull();
        return;
      }
      if (index === 0) {
        await Promise.race([
          firstNativeStarted.promise,
          completed.promise.then(() => {
            throw new Error(
              `Fresh first native turn did not acquire its owner: ${JSON.stringify(attemptErrors)}`,
            );
          }),
        ]);
      }
    }
  } finally {
    releaseFirstNative.resolve();
  }
  await completed.promise;
  await first.work.runWhenIdle(() => {});
  const fetchOutcomes = await Promise.allSettled(
    repositoryProof.fetchFixture.mock.results.flatMap((result) =>
      result.type === "return" ? [result.value] : [],
    ),
  );
  expect(
    effects.map(({ profileId }) => profileId),
    JSON.stringify({
      attemptedRuns,
      attemptErrors,
      fetchFailures: fetchOutcomes.flatMap((result) =>
        result.status === "rejected"
          ? [result.reason instanceof Error ? result.reason.message : "unknown fetch error"]
          : [],
      ),
      placement: native!.placements.get(sessionId),
    }),
  ).toEqual(issuers.map(({ profile }) => profile.id));
  expect(effects.map(({ runId, body }) => ({ runId, body }))).toEqual(
    requests.map(({ runId, text }) => ({ runId, body: text })),
  );
  expect(native!.coldAllocations()).toBe(0);
  expect(native!.redispatches()).toBe(1);
  const warm = expectDefined(native!.warmReceipt(), "original warm reserve receipt");
  expect(native!.environment.environmentId).toBe(warm.environmentId);
  expectDefined(native!.environment.preparation?.consumedAtMs, "consumed warm preparation");
  await facades[0]!.dispatch({
    ...target,
    sessionId,
    message: requests[0]!.text,
    idempotencyKey: requests[0]!.runId,
    deliver: false,
  });
  await first.work.runWhenIdle(() => {});
  expect(effects).toHaveLength(3);
  expect(native!.redispatches()).toBe(1);
}

export async function prepareQueuedNativeRecoveryFixture(params: {
  first: Awaited<ReturnType<typeof createOriginalIssuerFixture>>;
  target: { agentId: string; sessionKey: string };
  sessionId: string;
  workerRoot: string;
  nativeAttempt: Mock<AgentHarnessV2["runAttempt"]>;
  requests: readonly { runId: string; text: string }[];
  issuers: readonly Awaited<ReturnType<typeof createOriginalIssuerFixture>>[];
  effects: Array<{ runId: string; profileId: string; body: string }>;
  executionIndexes: readonly number[];
  onCompleted: () => void;
  getBrokerContext: () => Awaited<ReturnType<typeof createOriginalIssuerFixture>>["context"];
  repositoryProof: ReturnType<typeof installFactoryRestartRepositoryFixture>;
  pendingReclaim?: boolean;
  failedBeforeSelection?: boolean;
  failedBeforeActivation?: boolean;
  beforeFirstEffect?: () => Promise<void>;
}) {
  const originalIssuers = params.issuers.map((issuer) =>
    expectDefined(
      issuer.original!.authority.captureRestartRecoveryIssuer?.(),
      "original accepted queued issuer basis",
    ),
  );
  await fs.mkdir(params.workerRoot, { recursive: true });
  const native = await prepareGoalRecoveryNativeFixture(
    params.first,
    params.target,
    params.sessionId,
    params.workerRoot,
    true,
    params.failedBeforeSelection && !params.failedBeforeActivation,
    params.repositoryProof,
    params.failedBeforeSelection ? "warm" : undefined,
    false,
    undefined,
    false,
    params.pendingReclaim,
    params.failedBeforeSelection,
    params.failedBeforeActivation,
  );
  params.nativeAttempt.mockImplementation(async (attempt) => {
    const index = expectDefined(
      params.executionIndexes[params.effects.length],
      "next accepted FIFO index",
    );
    const issuer = expectDefined(params.issuers[index], "original queued issuer");
    const accepted = expectDefined(params.requests[index], "original accepted queued input");
    const scope = expectDefined(getPluginRuntimeGatewayRequestScope(), "native queued scope");
    const authority = expectDefined(
      getGatewayToolCallerIdentity()?.operatorAuthority ??
        scope.client?.internal?.operatorRunAuthority,
      "original queued native authority",
    );
    expect(authority.profileId).toBe(issuer.profile.id);
    expect(authority.scopes).toEqual(["operator.read", "operator.write"]);
    expect(authority.captureRestartRecoveryIssuer?.()).toEqual(originalIssuers[index]);
    expect(authority.modelPolicy?.allows({ provider: "openai", model: "allowed" })).toBe(true);
    expect(authority.modelPolicy?.allows({ provider: "openai", model: "other" })).toBe(false);
    expect(attempt.provider).toBe("openai");
    expect(attempt.modelId).toBe("allowed");
    expect(attempt.sessionId).toBe(params.sessionId);
    expect(attempt.sessionKey).toBe(params.target.sessionKey);
    if (index > 0 || params.failedBeforeSelection) {
      expect(attempt.runId).toBe(accepted.runId);
      expect(attempt.prompt).toContain(accepted.text);
    }
    const assertNativeCurrent = expectDefined(
      scope.assertNodeExecutionCurrent,
      "native queued effect guard",
    );
    expect(native.placements.get(params.sessionId)).toMatchObject({
      state: "active",
      executionMode: "remote-exec",
      turnClaim: { runId: attempt.runId },
    });
    const request = {
      runId: attempt.runId,
      agentId: params.target.agentId,
      nodeId: native.environment.nodeDeviceId!,
      workspace: {
        workspaceDir: native.remoteWorkspaceDir,
        environmentId: native.environment.environmentId,
        ownerEpoch: native.environment.ownerEpoch,
        sessionId: params.sessionId,
        sessionKey: params.target.sessionKey,
      },
    };
    const assertCurrent = () => {
      authority.assertCurrent();
      assertNativeCurrent(request);
    };
    assertCurrent();
    if (params.effects.length === 0) {
      await params.beforeFirstEffect?.();
      assertCurrent();
    }
    const readNativeCredential = expectDefined(
      authority.createFactoryGitHubDispatchCredentialReader,
      "original queued dispatch reader",
    )({
      ...params.target,
      sessionId: params.sessionId,
      repositoryUrl: native.repository.url,
      assertCurrent,
    });
    const source = await prepareRepositoryWorkerProjectSource({
      namespace: "native-queued-original",
      repository: { agentId: params.target.agentId, url: native.repository.url, ref: "main" },
      getConfig: params.getBrokerContext().getRuntimeConfig,
      assertCurrent,
      readNativeCredential,
    });
    expect(source.project.source.url).toBe(native.repository.url);
    assertCurrent();
    const history = await readIssuerFixtureHistory(params.target, params.sessionId);
    expect(
      history.filter(
        (message) =>
          isRecord(message) &&
          message.idempotencyKey === buildRunUserTurnIdempotencyKey(accepted.runId),
      ),
    ).toEqual([expect.objectContaining({ role: "user", content: accepted.text })]);
    assertCurrent();
    const tunnel = await expectDefined(
      native.environments.startTunnel,
      "current native transport",
    )({
      environmentId: native.environment.environmentId,
      ownerEpoch: native.environment.ownerEpoch,
    });
    assertCurrent();
    const result = await tunnel.runWorkspaceCommand({
      argv: [
        "node",
        "-e",
        "process.stdout.write(require('node:fs').readFileSync('accepted.txt', 'utf8'))",
      ],
      timeoutMs: 10_000,
      transportRetry: "never",
      assertCurrent,
    });
    assertCurrent();
    expect(result).toMatchObject({ code: 0, stdout: "accepted marker" });
    params.effects.push({
      runId: attempt.runId,
      profileId: authority.profileId,
      body: accepted.text,
    });
    if (params.effects.length === params.executionIndexes.length) {
      params.onCompleted();
    }
    return makeAttemptResult({
      terminal: { kind: "ok" },
      sessionIdUsed: params.sessionId,
      agentHarnessId: "codex",
      assistantTexts: ["Accepted native queued input completed"],
      lastAssistant: makeAgentAssistantMessage({
        content: [{ type: "text", text: "Accepted native queued input completed" }],
        timestamp: Date.now(),
      }),
    });
  });
  return native;
}

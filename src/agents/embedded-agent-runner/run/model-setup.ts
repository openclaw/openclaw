import { loadSessionEntryReadOnly } from "../../../config/sessions/session-accessor.js";
import { withSessionEntriesFromStoresInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import type { InternalSessionEntry as SessionEntry } from "../../../config/sessions/types.js";
import { assertAgentRunLifecycleGenerationCurrent } from "../../../infra/agent-events.js";
import { requireActivePluginRegistry } from "../../../plugins/runtime.js";
import { resolveSessionPinnedHarnessId } from "../../../sessions/agent-harness-session-key.js";
import { sessionChanges } from "../../../sessions/session-row-changes.js";
import {
  prepareSessionRowPublicationScope,
  sessionChangeAffectsStoredRow,
} from "../../../sessions/session-row-facts.js";
import { isIncognitoSessionKey } from "../../../shared/incognito-session-key.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import {
  assertOperatorModelAllowed,
  readRunOperatorAuthority,
} from "../../admitted-run-context.js";
import { resolveSessionAgentIdsStrict } from "../../agent-scope.js";
import { createNativeModelOwnedRuntimeModel } from "../../defaults.js";
import { FailoverError } from "../../failover-error.js";
import { AgentHarnessPreflightError } from "../../harness/errors.js";
import {
  assertAgentHarnessExecutionEnvironment,
  resolveAgentHarnessNativeToolPolicyRestricted,
} from "../../harness/execution-environment.js";
import { resolveReadyNativeModelCatalogEntry } from "../../harness/native-model-catalog-resolution.js";
import { getRegisteredAgentHarness } from "../../harness/registry.js";
import { ensureSelectedAgentHarnessPlugin } from "../../harness/runtime-plugin.js";
import { selectAgentHarness } from "../../harness/selection.js";
import { readSessionRuntimeOwnership } from "../../harness/session-runtime-ownership.js";
import { assertPluginHarnessConversationToolPolicySupport } from "../../harness/support.js";
import type { AgentHarness } from "../../harness/types.js";
import { resolveModelCandidateChain } from "../../model-fallback-candidates.js";
import type { ModelRef } from "../../model-selection.js";
import { resolveSelectedOpenAIRuntimeProvider } from "../../openai-routing.js";
import { assertPreparedModelRuntimeInputCurrent } from "../../prepared-model-runtime.errors.js";
import type { PreparedModelRuntimeSnapshot } from "../../prepared-model-runtime.js";
import { resolveTieredModel } from "../model-resolution.js";
import { createEmptyAgentDiscoveryStores } from "../model.js";
import type { RunEmbeddedAgentInternalParams } from "./internal-params.js";
import { resolveRequestStreamTransportOverrides } from "./runtime-resolution.js";
import type { assertAgentHarnessRunAdmission } from "./session-bootstrap.js";
import { buildBeforeModelResolveAttachments, resolveHookModelSelection } from "./setup.js";

export type PreparedNativeSessionRuntime = {
  harness: AgentHarness;
  assertCurrent: () => Promise<void>;
} & ({ auth: "native"; modelRef?: ModelRef } | { auth: "host"; modelRef: ModelRef });

class NativeSessionOwnershipReadRaceError extends Error {}

async function prepareNativeSessionRuntime(
  runParams: RunEmbeddedAgentInternalParams,
  harness: AgentHarness,
  admission: Awaited<ReturnType<typeof assertAgentHarnessRunAdmission>>,
  assertCallerCurrent: () => void,
): Promise<PreparedNativeSessionRuntime | undefined> {
  const pinnedHarnessId = resolveSessionPinnedHarnessId(admission?.entry);
  if (!admission || !pinnedHarnessId || !harness.resolveSessionRuntimeOwnership) {
    return undefined;
  }
  const { sessionId, lifecycleRevision } = admission.entry;
  const ownershipChangedMessage =
    "Native model ownership changed during run preparation. Reattach the original native session before retrying.";
  const { sessionAgentId } = resolveSessionAgentIdsStrict({
    config: runParams.config,
    agentId: admission.agentId,
    sessionKey: admission.sessionKey,
  });
  const readOwnership = async () => {
    assertCallerCurrent();
    const publication = prepareSessionRowPublicationScope([
      admission.storePath,
      ...(isIncognitoSessionKey(admission.sessionKey)
        ? [resolveIncognitoOpenClawAgentSqlitePath({ agentId: sessionAgentId })]
        : []),
    ]);
    let changed = false;
    const stop = sessionChanges.subscribeFacts((change) => {
      if (
        sessionChangeAffectsStoredRow(change, {
          ...publication,
          agentId: sessionAgentId,
          sessionKeys: [admission.sessionKey],
        })
      ) {
        changed = true;
      }
    });
    try {
      const consume = (current: SessionEntry | undefined, assertReadCurrent: () => void) => {
        const assertCurrent = () => {
          assertCallerCurrent();
          runParams.abortSignal?.throwIfAborted();
          if (runParams.lifecycleGeneration) {
            assertAgentRunLifecycleGenerationCurrent(runParams.lifecycleGeneration);
          }
          try {
            assertReadCurrent();
            if (changed) {
              throw new NativeSessionOwnershipReadRaceError();
            }
          } catch (cause) {
            if (cause instanceof NativeSessionOwnershipReadRaceError) {
              throw cause;
            }
            throw new AgentHarnessPreflightError(ownershipChangedMessage, { cause });
          }
          const expectedWriter = runParams.sessionTarget?.expectedWriterRunId;
          if (
            getRegisteredAgentHarness(pinnedHarnessId)?.harness !== harness ||
            current?.sessionId !== sessionId ||
            current?.lifecycleRevision !== lifecycleRevision ||
            resolveSessionPinnedHarnessId(current) !== pinnedHarnessId ||
            (expectedWriter !== undefined && current?.activeWriterRunId !== expectedWriter)
          ) {
            throw new AgentHarnessPreflightError(ownershipChangedMessage);
          }
        };
        assertCurrent();
        return readSessionRuntimeOwnership({
          config: runParams.config,
          agentId: admission.agentId,
          sessionKey: admission.sessionKey,
          storePath: admission.storePath,
          sessionEntry: current,
          assertCurrent,
          readPreparedPreviousSessionId: () => current?.previousSessionId,
        });
      };
      if (isIncognitoSessionKey(admission.sessionKey)) {
        return consume(loadSessionEntryReadOnly(admission), () => {});
      }
      return await withSessionEntriesFromStoresInWorker(
        [
          {
            agentId: sessionAgentId,
            sessionKeys: [admission.sessionKey],
            lifecycleSessionKey: admission.sessionKey,
            storePath: admission.storePath,
            includeAuthorization: true,
            snapshotFields: [],
          },
        ],
        ([read]) =>
          consume(
            read!.result.entries.find((item) => item.sessionKey === admission.sessionKey)?.entry,
            read!.assertCurrent,
          ),
        { prepareSource: (_input, ...source) => publication.prepareSource(...source) },
      );
    } finally {
      stop();
    }
  };
  const resolveOwnership = async () => {
    // A row publication can race the worker reply; re-read once under the same caller authority.
    for (let attempt = 0; ; attempt += 1) {
      try {
        const ownership = await readOwnership();
        assertCallerCurrent();
        return ownership;
      } catch (error) {
        if (!(error instanceof NativeSessionOwnershipReadRaceError)) {
          throw error;
        }
        if (attempt > 0) {
          throw new AgentHarnessPreflightError(ownershipChangedMessage, { cause: error });
        }
      }
    }
  };
  const ownership = await resolveOwnership();
  if (!ownership) {
    throw new AgentHarnessPreflightError(
      "The pinned runtime's native session ownership is unavailable. Reattach the original native session instead of starting a replacement model run.",
    );
  }
  const operatorAuthority = readRunOperatorAuthority(runParams);
  assertOperatorModelAllowed(operatorAuthority, ownership.modelRef);
  if (ownership.auth === "host" && !ownership.modelRef) {
    throw new AgentHarnessPreflightError(
      "The native session's model and provider are unavailable for host authentication. Reattach the original native session before retrying.",
    );
  }
  let currentOwnership = ownership;
  return {
    harness,
    ...(ownership.auth === "host"
      ? { auth: "host", modelRef: ownership.modelRef! }
      : {
          auth: "native",
          get modelRef() {
            return currentOwnership.modelRef;
          },
        }),
    // Compare host-prepared auth against its exact tuple; native auth may follow its owner's model.
    assertCurrent: async () => {
      const current = await resolveOwnership();
      assertOperatorModelAllowed(operatorAuthority, current?.modelRef);
      if (
        current?.model !== ownership.model ||
        current.auth !== ownership.auth ||
        (ownership.auth === "host" &&
          (current.modelRef?.provider !== ownership.modelRef?.provider ||
            current.modelRef?.model !== ownership.modelRef?.model))
      ) {
        throw new AgentHarnessPreflightError(
          "Native model ownership changed before agent harness dispatch. Reattach the original native session before retrying.",
        );
      }
      currentOwnership = current;
    },
  };
}

export async function resolveEmbeddedRunModelSetup(params: {
  assertCurrent: () => void;
  runParams: RunEmbeddedAgentInternalParams;
  sessionAdmission?: Awaited<ReturnType<typeof assertAgentHarnessRunAdmission>>;
  provider: string;
  modelId: string;
  agentDir: string;
  workspaceDir: string;
  globalLane: string;
  hookRunner: Parameters<typeof resolveHookModelSelection>[0]["hookRunner"];
  hookContext: Parameters<typeof resolveHookModelSelection>[0]["hookContext"];
  onHooksResolved: () => void;
  preparedModelRuntime?: PreparedModelRuntimeSnapshot;
}) {
  const runParams = params.runParams;
  const operatorAuthority = readRunOperatorAuthority(runParams);
  const hookSelection = await resolveHookModelSelection({
    prompt: runParams.prompt,
    attachments: buildBeforeModelResolveAttachments(runParams.images),
    provider: params.provider,
    modelId: params.modelId,
    modelSelectionLocked: runParams.modelSelectionLocked,
    hookRunner: params.hookRunner,
    hookContext: params.hookContext,
  });
  const modelSelectionChangedByHook =
    hookSelection.provider !== params.provider || hookSelection.modelId !== params.modelId;
  let provider = hookSelection.provider;
  let modelId = hookSelection.modelId;
  const requestStreamTransportOverrides = resolveRequestStreamTransportOverrides(
    runParams.streamParams,
  );
  params.onHooksResolved();

  await ensureSelectedAgentHarnessPlugin({
    provider,
    modelId,
    config: runParams.config,
    agentId: runParams.agentId,
    sessionKey: runParams.sessionKey,
    agentHarnessId: runParams.agentHarnessId,
    agentHarnessRuntimeOverride: runParams.agentHarnessRuntimeOverride,
    requestTransportOverrides: requestStreamTransportOverrides,
    workspaceDir: params.workspaceDir,
    pluginRegistry: params.preparedModelRuntime?.pluginRegistry ?? requireActivePluginRegistry(),
  });
  const pinnedHarnessId = resolveSessionPinnedHarnessId(params.sessionAdmission?.entry);
  const pinnedHarness = pinnedHarnessId
    ? getRegisteredAgentHarness(pinnedHarnessId)?.harness
    : undefined;
  const nativeSessionRuntime = pinnedHarness
    ? await prepareNativeSessionRuntime(
        runParams,
        pinnedHarness,
        params.sessionAdmission,
        params.assertCurrent,
      )
    : undefined;
  if (nativeSessionRuntime?.auth === "host") {
    provider = nativeSessionRuntime.modelRef.provider;
    modelId = nativeSessionRuntime.modelRef.model;
  }
  if (operatorAuthority?.modelPolicy && !nativeSessionRuntime) {
    const selected = resolveModelCandidateChain({
      cfg: runParams.config,
      agentId: runParams.agentId,
      provider,
      model: modelId,
      requestedRouteResolution: modelSelectionChangedByHook
        ? "raw"
        : runParams.requestedRouteResolution,
      fallbacksOverride: [],
      manifestPlugins: params.preparedModelRuntime?.metadataSnapshot,
    })[0];
    assertOperatorModelAllowed(operatorAuthority, selected);
  }
  const requestedModelId = modelId;
  if (nativeSessionRuntime?.auth === "native" && requestStreamTransportOverrides) {
    throw new AgentHarnessPreflightError(
      "Native session connections cannot apply provider stream parameters. Use a concrete model chat for this request.",
    );
  }
  const agentHarness =
    nativeSessionRuntime?.auth === "native"
      ? nativeSessionRuntime.harness
      : selectAgentHarness({
          provider,
          modelId,
          ...(requestStreamTransportOverrides
            ? {
                modelProvider: {
                  requestTransportOverrides: requestStreamTransportOverrides,
                },
              }
            : {}),
          config: runParams.config,
          agentId: runParams.agentId,
          sessionKey: runParams.sessionKey,
          agentHarnessId: runParams.agentHarnessId,
          agentHarnessRuntimeOverride: runParams.agentHarnessRuntimeOverride,
        });
  const nativePermissionsConsented = assertAgentHarnessExecutionEnvironment(
    agentHarness,
    runParams,
  );
  if (agentHarness.executionEnvironment === "host-only" && !nativePermissionsConsented) {
    assertPluginHarnessConversationToolPolicySupport(
      agentHarness,
      resolveAgentHarnessNativeToolPolicyRestricted(
        { ...runParams, provider, modelId },
        agentHarness,
      ),
    );
  }
  const pluginHarnessOwnsTransport = agentHarness.id !== "openclaw";
  const expectedHarnessArtifact = runParams.expectedAgentHarnessRuntimeArtifact;
  if (expectedHarnessArtifact && expectedHarnessArtifact.harnessId !== agentHarness.id) {
    throw new Error(
      `Verified inference requires agent harness ${expectedHarnessArtifact.harnessId}, but ${agentHarness.id} was selected.`,
    );
  }
  if (expectedHarnessArtifact && !agentHarness.runtimeArtifact) {
    throw new Error(
      `Agent harness ${agentHarness.id} cannot attest the verified inference runtime artifact.`,
    );
  }

  const nativeCatalogSelection = nativeSessionRuntime
    ? undefined
    : await resolveReadyNativeModelCatalogEntry({
        snapshot: params.preparedModelRuntime,
        harness: agentHarness,
        provider,
        modelId,
        ...(runParams.authProfileIdSource && runParams.authProfileId
          ? { authProfileId: runParams.authProfileId }
          : {}),
      });
  const nativeCatalogEntry = nativeCatalogSelection?.entry;
  runParams.abortSignal?.throwIfAborted();
  if (!nativeSessionRuntime && nativeCatalogSelection && params.preparedModelRuntime) {
    assertPreparedModelRuntimeInputCurrent(
      params.preparedModelRuntime,
      params.preparedModelRuntime.isCurrent,
    );
  }
  const nativeModelOwned = nativeSessionRuntime !== undefined || nativeCatalogEntry !== undefined;
  const modelConfigProvider = provider;
  let resolvedModelProvider = provider;
  let modelResolution;
  if (nativeModelOwned) {
    const nativeModel = createNativeModelOwnedRuntimeModel({ provider, modelId });
    // Keep native transport ownership while carrying only the capabilities the
    // current native inventory actually reported.
    const catalogModel = nativeCatalogEntry
      ? {
          ...nativeModel,
          name: nativeCatalogEntry.name,
          ...(nativeCatalogEntry.api ? { api: nativeCatalogEntry.api } : {}),
          ...(nativeCatalogEntry.reasoning !== undefined
            ? { reasoning: nativeCatalogEntry.reasoning }
            : {}),
          ...(nativeCatalogEntry.input
            ? {
                input: nativeCatalogEntry.input.filter(
                  (input): input is "text" | "image" => input === "text" || input === "image",
                ),
              }
            : {}),
          ...(nativeCatalogEntry.contextWindow !== undefined
            ? { contextWindow: nativeCatalogEntry.contextWindow }
            : nativeCatalogEntry.contextTokens !== undefined
              ? { contextWindow: nativeCatalogEntry.contextTokens }
              : {}),
          ...(nativeCatalogEntry.contextTokens !== undefined
            ? { contextTokens: nativeCatalogEntry.contextTokens }
            : {}),
          ...(nativeCatalogEntry.params ? { params: nativeCatalogEntry.params } : {}),
          ...(nativeCatalogEntry.compat ? { compat: nativeCatalogEntry.compat } : {}),
        }
      : nativeModel;
    if (
      nativeCatalogEntry &&
      nativeCatalogEntry.contextWindow === undefined &&
      nativeCatalogEntry.contextTokens === undefined
    ) {
      Reflect.deleteProperty(catalogModel, "contextWindow");
      Reflect.deleteProperty(catalogModel, "contextTokens");
      Reflect.deleteProperty(catalogModel, "maxTokens");
    }
    modelResolution = {
      model: catalogModel,
      ...createEmptyAgentDiscoveryStores(),
    };
  } else {
    const selectedRuntimeProvider = resolveSelectedOpenAIRuntimeProvider({
      provider,
      harnessRuntime: agentHarness.id,
      agentHarnessId: agentHarness.id,
      authProfileProvider: runParams.authProfileId?.split(":", 1)[0],
      authProfileId: runParams.authProfileId,
      config: runParams.config,
      workspaceDir: params.workspaceDir,
    });
    const tieredResolution = await resolveTieredModel({
      abortSignal: runParams.abortSignal,
      assertCurrent: params.assertCurrent,
      provider: selectedRuntimeProvider,
      ...(selectedRuntimeProvider !== provider ? { fallbackProvider: provider } : {}),
      modelId,
      agentDir: params.agentDir,
      requestedRouteResolution: modelSelectionChangedByHook
        ? "raw"
        : runParams.requestedRouteResolution,
      config: runParams.config,
      workspaceDir: params.workspaceDir,
      authProfileId: runParams.authProfileId,
      preparedModelRuntime: params.preparedModelRuntime,
      staticCatalogOwnsTransport: pluginHarnessOwnsTransport,
    });
    resolvedModelProvider = tieredResolution.provider;
    modelResolution = tieredResolution.resolution;
    if (modelResolution.model) {
      modelId = modelResolution.logicalRef.model;
    }
  }
  provider = resolvedModelProvider;
  if (!modelResolution.model) {
    throw new FailoverError(modelResolution.error ?? `Unknown model: ${provider}/${modelId}`, {
      reason: "model_not_found",
      provider,
      model: modelId,
      sessionId: runParams.sessionId,
      lane: params.globalLane,
    });
  }
  const { model, authStorage, modelRegistry } = modelResolution;
  if (!nativeSessionRuntime) {
    assertOperatorModelAllowed(operatorAuthority, { provider, model: modelId });
  }

  return {
    provider,
    modelId,
    requestedModelId,
    modelSelectionChangedByHook,
    requestStreamTransportOverrides,
    expectedHarnessArtifact,
    agentHarness,
    pluginHarnessOwnsTransport,
    pinnedHarnessId,
    nativeModelOwned,
    ...(nativeCatalogSelection?.assertCurrent
      ? { assertNativeModelSelectionCurrent: nativeCatalogSelection.assertCurrent }
      : {}),
    nativeSessionRuntime,
    modelConfigProvider,
    model,
    authStorage,
    modelRegistry,
  };
}

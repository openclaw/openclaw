import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  loadCodexBundleMcpThreadConfig,
  type EmbeddedRunAttemptParamsV2,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionUpstreamLinkAsync } from "openclaw/plugin-sdk/session-catalog";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { readVisibleSessionTranscriptMessageEntries } from "openclaw/plugin-sdk/session-transcript-runtime";
import { createStageTimingTracker } from "openclaw/plugin-sdk/time-runtime";
import { continueLocalCodexSession } from "../session-catalog-adoption.js";
import { createCodexSessionCatalogControl } from "../session-catalog-control.js";
import { registerCodexSessionCatalog } from "../session-catalog.js";
import {
  codexUpstreamContinueResult,
  type CodexUpstreamBaseline,
} from "../session-upstream-marker.js";
import { startCodexAttemptThread } from "./attempt-startup.js";
import { createCanonicalForkNativeFixture } from "./canonical-fork-native.test-support.js";
import type { CodexAppServerClient } from "./client.js";
import {
  resolveCodexComputerUseConfig,
  resolveCodexSupervisionAppServerRuntimeOptions,
  type CodexPluginConfig,
} from "./config.js";
import { prepareCodexNativeExecutionPolicyForRun } from "./native-execution-policy.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import type { CodexAttemptRuntime } from "./run-attempt-runtime.js";
import { prepareCodexAttemptTools } from "./run-attempt-tool-setup.js";
import {
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
} from "./session-binding-store.js";
import { createCodexAppServerBindingStore, sessionBindingIdentity } from "./session-binding.js";
import { createCodexSqliteTestBindingStateStore } from "./session-binding.sqlite.test-helpers.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import { resetSharedCodexAppServerClientForTests } from "./shared-client.test-support.js";
import { createCodexTestModel } from "./test-support.js";
import {
  codexTranscriptMirrorRuntime,
  createCodexAppServerUserMessagePersistenceNotifier,
  mirrorPromptAtTurnStartBestEffort,
} from "./transcript-mirror.js";
import { promptSnapshot } from "./user-prompt-message.js";

type Invalidate = (reason: "closed" | "aborted" | "replaced" | "claim") => Promise<void>;

export async function createCanonicalForkFixture(params: {
  runtime: PluginRuntime;
  workspaceDir: string;
  agentDir: string;
  config: OpenClawConfig;
  loading?: "searchable" | "direct";
  codexPlugins?: CodexPluginConfig["codexPlugins"];
  desktopGenerationFingerprint?: string;
  senderIsOwner?: boolean;
  createHost: (params: {
    sessionId: string;
    sessionKey: string;
    runId: string;
    storePath: string;
    prompt: string;
    senderIsOwner?: boolean;
    senderId?: string;
    workerOwned?: boolean;
  }) => Promise<{
    capabilities: EmbeddedRunAttemptParamsV2["hostCapabilities"];
    close: () => void | Promise<void>;
    abortController: AbortController;
    invalidate: Invalidate;
    runWithScope: <T>(run: () => Promise<T>) => Promise<T>;
    userTurnTranscriptRecorder: EmbeddedRunAttemptParamsV2["userTurnTranscriptRecorder"];
  }>;
}) {
  const { runtime, config, workspaceDir, agentDir } = params;
  const native = await createCanonicalForkNativeFixture(
    path.join(workspaceDir, "codex-home"),
    workspaceDir,
    params.loading === "direct" ? "paginated" : "legacy",
    params.desktopGenerationFingerprint,
  );
  native.source.thread.source = "cli";
  await native.persist(native.source);
  const pluginConfig: CodexPluginConfig = {
    ...(params.loading ? { codexDynamicToolsLoading: params.loading } : {}),
    ...(params.codexPlugins ? { codexPlugins: params.codexPlugins } : {}),
    supervision: { enabled: true },
    sessionCatalog: { homes: [native.home] },
    appServer: {
      command: process.execPath,
      args: ["app-server"],
      approvalsReviewer: "user",
    },
  };
  const controls = createCodexSessionCatalogControl({
    resolveRuntimeOptions: resolveCodexSupervisionAppServerRuntimeOptions,
    config,
    getRuntimeConfig: () => config,
    getPluginConfig: () => pluginConfig,
    env: { HOME: workspaceDir, CODEX_HOME: path.join(workspaceDir, "primary-codex-home") },
  });
  const home = expectDefined(
    (await controls.homesForAgent("main")).find(
      (candidate) => candidate.localSessionsRoot === native.sessionsRoot,
    ),
    "native fixture home",
  );
  const fingerprint = buildCodexAppServerConnectionFingerprint(home.appServer, agentDir);
  const control = expectDefined(
    await controls.forUpstream("main", fingerprint),
    "native fixture control",
  );
  const storePath = resolveStorePath(config.session?.store, { agentId: "main" });
  const bindingStore = createCodexAppServerBindingStore(
    createCodexSqliteTestBindingStateStore({
      namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
      maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
      overflowPolicy: "reject-new",
      env: { ...process.env },
    }),
  );
  const captured = createCapturedPluginRegistration({ id: "codex", config });
  const api = { ...captured.api, runtime };
  registerCodexSessionCatalog({
    resolveRuntimeOptions: resolveCodexSupervisionAppServerRuntimeOptions,
    api,
    bindingStore,
    control: controls,
    getPluginConfig: () => pluginConfig,
    getRuntimeConfig: () => config,
  });
  const identity = (key: string) => {
    const entry = expectDefined(getSessionEntry({ sessionKey: key, storePath }), "session entry");
    return sessionBindingIdentity({
      agentId: "main",
      sessionId: entry.sessionId,
      sessionKey: key,
      config,
    });
  };
  const clientOptions = {
    startOptions: home.appServer.start,
    agentDir,
    config,
    authProfileId: null,
  };
  const readEntries = (key: string) =>
    readVisibleSessionTranscriptMessageEntries({
      agentId: "main",
      sessionKey: key,
      sessionId: identity(key).sessionId,
      storePath,
    });
  const turn = async (
    key: string,
    text: string,
    options: {
      senderIsOwner?: boolean;
      senderId?: string;
      workerOwned?: boolean;
      developerInstructions?: string;
      beforeStartup?: (invalidate: Invalidate) => Promise<void> | void;
      inspectTools?: (tools: {
        bridge: Awaited<ReturnType<typeof prepareCodexAttemptTools>>["toolBridge"];
        invalidate: Invalidate;
      }) => Promise<void>;
    } = {},
  ) => {
    const senderIsOwner = options.senderIsOwner ?? params.senderIsOwner;
    const session = identity(key);
    const turnInput = {
      sessionId: session.sessionId,
      sessionKey: key,
      runId: randomUUID(),
      prompt: text,
      senderIsOwner,
      senderId: options.senderId,
    };
    const host = await params.createHost({
      ...turnInput,
      storePath,
      workerOwned: options.workerOwned,
    });
    try {
      return await host.runWithScope(async () => {
        const model = {
          ...createCodexTestModel("openai", ["text", "image"]),
          id: "gpt-5.6-luna",
          name: "gpt-5.6-luna",
          contextWindow: undefined,
          maxTokens: undefined,
        };
        // The host owns admission and publication readiness; the native transport
        // supplies connection facts without provider authentication or a model turn.
        const attempt = {
          ...turnInput,
          config,
          agentId: "main",
          agentDir,
          workspaceDir,
          cwd: workspaceDir,
          sessionTarget: { ...session, storePath },
          userTurnTranscriptRecorder: host.userTurnTranscriptRecorder,
          provider: "codex",
          modelId: model.id,
          model,
          hostCapabilities: host.capabilities,
          timeoutMs: 10_000,
          authProfileStore: { version: 1, profiles: {} },
          githubPublicationAvailable: false,
          abortSignal: host.abortController.signal,
        } as unknown as EmbeddedRunAttemptParamsV2;
        const runAbortController = host.abortController;
        const startupBinding = bindingStore.read(session);
        const bundleMcpThreadConfig = await loadCodexBundleMcpThreadConfig({
          workspaceDir,
          agentId: attempt.agentId,
          cfg: config,
          toolsEnabled: true,
        });
        const connectionContext = {
          agentDir,
          pluginConfig,
          appServer: home.appServer,
          effectiveWorkspace: workspaceDir,
          effectiveCwd: workspaceDir,
          sessionAgentId: "main",
          attemptClientFactory: getLeasedSharedCodexAppServerClient,
        };
        const nativeSurface = {
          nativeToolSurfaceEnabled: true,
          nativeProviderWebSearchSupport: "supported" as const,
          bundleMcpThreadConfig,
        };
        // SAFETY: fixture connection facts replace native/auth startup only.
        // Tool factories, admitted composition, and schema projection remain real.
        const toolRuntime = {
          connection: {
            ...connectionContext,
            assertCurrent: host.capabilities.assertActive,
            params: attempt,
            startupClientAuthProfileId: null,
            preDynamicStartupStages: createStageTimingTracker(),
            mutable: { startupBinding },
            resolvedWorkspace: workspaceDir,
            sandboxSessionKey: key,
            sandbox: null,
            runAbortController,
            policyAgentId: "main",
            contextSessionKey: key,
            profilerEnabled: false,
            usesSupervisionConnection: true,
          },
          runtimeParams: attempt,
          effectiveRuntimeModelId: model.id,
          nativeExecutionPolicy: await prepareCodexNativeExecutionPolicyForRun(attempt, {
            agentId: "main",
            runtimeSessionKey: key,
            sandbox: null,
          }),
          ...nativeSurface,
        } as unknown as CodexAttemptRuntime;
        const preparedTools = await prepareCodexAttemptTools(toolRuntime);
        let startup: Awaited<ReturnType<typeof startCodexAttemptThread>> | undefined;
        try {
          await options.beforeStartup?.(host.invalidate);
          startup = await startCodexAttemptThread({
            ...connectionContext,
            ...nativeSurface,
            config,
            bindingStore,
            buildAttemptParams: () => attempt,
            computerUseConfig: resolveCodexComputerUseConfig({ pluginConfig }),
            clientOptions: { authProfileId: null },
            startupAuthAccountCacheKey: undefined,
            startupEnvApiKeyCacheKey: undefined,
            dynamicTools: preparedTools.toolBridge.specs,
            webSearchAllowed: preparedTools.toolState.webSearchAllowed,
            persistentWebSearchAllowed: preparedTools.toolState.persistentWebSearchAllowed,
            developerInstructions: options.developerInstructions,
            sandboxExecServerEnabled: false,
            sandbox: null,
            contextEngineProjection: undefined,
            startupTimeoutMs: 10_000,
            signal: runAbortController.signal,
            onStartupTimeout: () => runAbortController.abort(),
            spawnedBy: undefined,
          });
          const binding = startup.thread;
          const client = startup.client;
          const response = await client.request(
            "turn/start",
            {
              threadId: binding.threadId,
              input: [{ type: "text", text, text_elements: [] }],
            },
            { timeoutMs: 10_000 },
          );
          const notifyUserMessagePersisted =
            createCodexAppServerUserMessagePersistenceNotifier(attempt);
          const mirrorParams = {
            params: attempt,
            sessionKey: key,
            agentId: "main",
            cwd: workspaceDir,
            threadId: binding.threadId,
            turnId: response.turn.id,
            notifyUserMessagePersisted,
          };
          await mirrorPromptAtTurnStartBestEffort({ ...mirrorParams, upstreamUserText: text });
          const promptAdmission = host.userTurnTranscriptRecorder?.getAdmissionReceipt();
          await codexTranscriptMirrorRuntime.mirrorBestEffort({
            ...mirrorParams,
            // SAFETY: this fixture's native transport emits only its accepted user prompt.
            result: {
              messagesSnapshot: promptSnapshot(attempt, response.turn.id, text),
            } as Parameters<typeof codexTranscriptMirrorRuntime.mirrorBestEffort>[0]["result"],
          });
          if (
            host.userTurnTranscriptRecorder?.getAdmissionReceipt()?.generation !==
            promptAdmission?.generation
          ) {
            throw new Error("final snapshot rewrote the admitted prompt");
          }
          await client.request("thread/unsubscribe", { threadId: binding.threadId });
          await options.inspectTools?.({
            bridge: preparedTools.toolBridge,
            invalidate: host.invalidate,
          });
          return binding;
        } finally {
          startup?.turnRoute.release();
          startup?.releaseSharedClientLease();
          runAbortController.abort();
          await preparedTools.disposeTools("fixture complete");
        }
      });
    } finally {
      await host.close();
    }
  };
  return {
    native,
    pluginConfig,
    catalog: expectDefined(captured.sessionCatalogs[0], "registered catalog"),
    async withClient<T>(run: (client: CodexAppServerClient) => Promise<T>) {
      const client = await getLeasedSharedCodexAppServerClient(clientOptions);
      try {
        return await run(client);
      } finally {
        releaseLeasedSharedCodexAppServerClient(client);
      }
    },
    bindingStore,
    identity,
    readEntries,
    turn,
    storePath,
    config,
    adopt: async () => {
      let baseline: (CodexUpstreamBaseline & { connectionFingerprint: string }) | undefined;
      const result = await continueLocalCodexSession({
        api,
        agentId: "main",
        bindingStore,
        config,
        control,
        threadId: native.source.thread.id,
        onContinued: (value) => {
          baseline = value;
        },
      });
      const upstream = expectDefined(
        codexUpstreamContinueResult(result.sessionKey, native.source.thread.id, baseline).upstream,
        "adopted upstream",
      );
      // Seed the catalog response through the same canonical link store as its Gateway caller.
      if (
        !(await upsertSessionUpstreamLinkAsync({
          sessionKey: result.sessionKey,
          agentId: "main",
          catalogId: "codex",
          hostId: home.hostId,
          threadId: native.source.thread.id,
          upstreamKind: upstream.kind,
          upstreamRef: upstream.ref,
          marker: upstream.marker,
        }))
      ) {
        throw new Error("Failed to seed catalog upstream link");
      }
      return result;
    },
    async dispose() {
      await native.dispose();
      resetSharedCodexAppServerClientForTests();
    },
  };
}

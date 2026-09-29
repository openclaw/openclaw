import path from "node:path";
import { expect, it, type Mock } from "vitest";
import { ensureCodexAppServerClientRuntime } from "./client-runtime.js";
import { buildCodexRuntimeModelParams, type CodexMultiAgentVersion } from "./model-runtime.js";
import type { JsonObject } from "./protocol.js";
import { tempDir, threadStartResult } from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  type writeCodexAppServerBinding as writeRawCodexAppServerBinding,
} from "./session-binding.test-helpers.js";
import type { startOrResumeThread as startOrResumeThreadImpl } from "./thread-lifecycle.js";
import { createLeasedCodexLifecycleHarness } from "./thread-lifecycle.test-fixtures.js";
import { retainCodexAppServerBindingSubscription } from "./thread-ownership.js";

type StartParams = Omit<Parameters<typeof startOrResumeThreadImpl>[0], "bindingStore">;
type LifecycleRespond = (method: string, requestParams?: unknown) => Promise<unknown>;

type ModelCompatibilityFixtures = {
  createParams: (sessionFile: string, workspaceDir: string) => StartParams["params"];
  createLifecycleRequest: (
    respond: LifecycleRespond,
    effectiveConfig?: JsonObject,
  ) => Mock<LifecycleRespond>;
  startOrResumeThread: (
    params: Pick<StartParams, "client"> & Partial<StartParams>,
  ) => ReturnType<typeof startOrResumeThreadImpl>;
  writeCodexAppServerBinding: typeof writeRawCodexAppServerBinding;
  retainThread: (
    client: StartParams["client"],
    binding: Awaited<ReturnType<typeof startOrResumeThreadImpl>>,
  ) => Promise<boolean>;
  preflightMethods: readonly string[];
  coldResumeMethods: readonly string[];
};

type WarmModelCompatibilityCase = {
  scenario: string;
  bindingModel: string;
  multiAgentVersion?: CodexMultiAgentVersion;
  requestedModels: { model: string; version?: CodexMultiAgentVersion }[];
  expectedGeneration?: CodexMultiAgentVersion;
  config?: JsonObject;
  nativeConfig?: JsonObject;
  buildFinalConfigPatch?: StartParams["buildFinalConfigPatch"];
};

type ColdModelCompatibilityCase = {
  bindingModel: string;
  requestedModel: string;
  bindingVersion?: CodexMultiAgentVersion;
  requestedVersion?: CodexMultiAgentVersion;
  config?: JsonObject;
};

/** Reuse the binding suite's native lifecycle fixtures and database cleanup. */
export function registerThreadModelCompatibilityTests({
  createParams,
  createLifecycleRequest,
  startOrResumeThread,
  writeCodexAppServerBinding,
  retainThread,
  preflightMethods,
  coldResumeMethods,
}: ModelCompatibilityFixtures) {
  it.each<WarmModelCompatibilityCase>([
    {
      scenario: "a legacy model change",
      bindingModel: "gpt-5.4-codex",
      multiAgentVersion: undefined,
      requestedModels: [{ model: "gpt-5.5", version: undefined }],
    },
    {
      scenario: "v2, unknown, and v2 model selections",
      bindingModel: "synthetic-primary",
      multiAgentVersion: "v2",
      requestedModels: [
        { model: "synthetic-fallback", version: "v2" },
        { model: "synthetic-unclassified-model", version: undefined },
        { model: "synthetic-primary", version: "v2" },
      ],
    },
    {
      scenario: "catalog and legacy v2 model selections",
      bindingModel: "synthetic-primary",
      multiAgentVersion: "v2",
      requestedModels: [{ model: "gpt-5.6-sol", version: "v2" }],
    },
    {
      scenario: "v1 and unknown model selections",
      bindingModel: "synthetic-v1-model",
      multiAgentVersion: "v1",
      requestedModels: [{ model: "synthetic-unclassified-model", version: undefined }],
    },
    {
      scenario: "disabled and unknown model selections",
      bindingModel: "synthetic-disabled-model",
      multiAgentVersion: "disabled",
      requestedModels: [{ model: "synthetic-unclassified-model", version: undefined }],
    },
    {
      scenario: "disabled delegation across v2, v1, and disabled catalog models",
      bindingModel: "synthetic-v2-model",
      multiAgentVersion: "v2",
      requestedModels: [
        { model: "synthetic-v1-model", version: "v1" },
        { model: "synthetic-disabled-model", version: "disabled" },
      ],
      expectedGeneration: "disabled",
      config: { "agents.enabled": false, "features.multi_agent_v2": false },
    },
    {
      scenario: "delegation disabled by the final dynamic configuration",
      bindingModel: "synthetic-v2-model",
      multiAgentVersion: "v2",
      requestedModels: [{ model: "synthetic-v1-model", version: "v1" }],
      expectedGeneration: "disabled",
      buildFinalConfigPatch: () => ({
        configPatch: { "agents.enabled": false, "features.multi_agent_v2": false },
      }),
    },
    {
      scenario: "inherited forced v2 taking precedence over disabled agents",
      bindingModel: "synthetic-v1-model",
      multiAgentVersion: "v1",
      requestedModels: [{ model: "synthetic-disabled-model", version: "disabled" }],
      expectedGeneration: "v2",
      config: { "agents.enabled": false },
      nativeConfig: { features: { multi_agent_v2: { enabled: true } } },
    },
  ])(
    "preserves thread generation and workspace ownership across $scenario",
    async ({
      bindingModel,
      requestedModels,
      multiAgentVersion,
      expectedGeneration = multiAgentVersion,
      config,
      nativeConfig,
      buildFinalConfigPatch,
    }) => {
      const sessionFile = path.join(tempDir, "warm-model-workspace.jsonl");
      const originalWorkspace = path.join(tempDir, "workspace-original");
      const currentWorkspace = path.join(tempDir, "workspace-current");
      const params = createParams(sessionFile, originalWorkspace);
      params.modelId = bindingModel;
      params.model = {
        ...params.model,
        id: bindingModel,
        params: buildCodexRuntimeModelParams(bindingModel, bindingModel, multiAgentVersion),
      };
      const request = createLifecycleRequest(async (method: string) => {
        if (method === "thread/start") {
          const response = threadStartResult("thread-warm-model-workspace", {
            cwd: originalWorkspace,
          });
          response.model = bindingModel;
          return response;
        }
        throw new Error(`unexpected method: ${method}`);
      }, nativeConfig);
      const client = {
        getInstanceId: () => "client-warm-model-workspace",
        request,
        addNotificationHandler: () => () => undefined,
        addRequestHandler: () => () => undefined,
        addCloseHandler: () => () => undefined,
      } as never;
      ensureCodexAppServerClientRuntime(client, { agentDir: originalWorkspace });
      const common = {
        client,
        params,
        cwd: originalWorkspace,
        userMcpServersEnabled: false,
        config,
        buildFinalConfigPatch,
      };
      const started = await startOrResumeThread(common);
      await expect(retainThread(client, started)).resolves.toBe(true);
      expect(started.nativeMultiAgentVersion).toBe(expectedGeneration);
      params.workspaceDir = currentWorkspace;
      const expectedMethods = [...preflightMethods, "thread/start"];

      for (const [index, requested] of requestedModels.entries()) {
        params.modelId = requested.model;
        params.model = {
          ...params.model,
          id: requested.model,
          params: buildCodexRuntimeModelParams(requested.model, requested.model, requested.version),
        };

        const reused = await startOrResumeThread({ ...common, cwd: currentWorkspace });

        expectedMethods.push(...preflightMethods);
        expect(request.mock.calls.map(([method]) => method)).toEqual(expectedMethods);
        expect(reused).toMatchObject({
          threadId: "thread-warm-model-workspace",
          cwd: currentWorkspace,
          model: requested.model,
        });
        expect(reused.nativeMultiAgentVersion).toBe(expectedGeneration);
        const saved = await readCodexAppServerBinding(sessionFile);
        expect(saved).toMatchObject({
          cwd: currentWorkspace,
          model: requested.model,
        });
        expect(saved?.nativeMultiAgentVersion).toBe(expectedGeneration);
        if (index < requestedModels.length - 1) {
          await expect(
            retainCodexAppServerBindingSubscription(
              client,
              reused.threadId,
              reused.liveThreadOwnership,
            ),
          ).resolves.toBe(true);
        }
      }
    },
  );

  it.each([
    {
      bindingModel: "gpt-5.6-luna",
      requestedModel: "gpt-5.6-sol",
      bindingVersion: undefined,
      requestedVersion: undefined,
    },
    {
      bindingModel: "synthetic-v2-model",
      requestedModel: "synthetic-v1-model",
      bindingVersion: "v2",
      requestedVersion: "v1",
    },
    {
      bindingModel: "synthetic-v2-model",
      requestedModel: "synthetic-disabled-model",
      bindingVersion: "v2",
      requestedVersion: "disabled",
    },
  ] as const)(
    "starts a fresh thread when switching from $bindingModel to $requestedModel",
    async ({ bindingModel, requestedModel, bindingVersion, requestedVersion }) => {
      const sessionFile = path.join(tempDir, `${bindingModel}-${requestedModel}.jsonl`);
      const workspaceDir = path.join(tempDir, "workspace");
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-existing",
        cwd: workspaceDir,
        model: bindingModel,
        ...(bindingVersion ? { nativeMultiAgentVersion: bindingVersion } : {}),
      });
      const params = createParams(sessionFile, workspaceDir);
      params.modelId = requestedModel;
      params.model = {
        ...params.model,
        id: requestedModel,
        params: buildCodexRuntimeModelParams(requestedModel, requestedModel, requestedVersion),
      };
      const request = createLifecycleRequest(async (method: string, requestParams?: unknown) => {
        if (method === "thread/start") {
          const response = threadStartResult("thread-rebound");
          response.model = (requestParams as { model: string }).model;
          return response;
        }
        throw new Error(`unexpected method: ${method}`);
      });

      const binding = await startOrResumeThread({
        client: { request } as never,
        params,
      });

      expect(request.mock.calls.map(([method]) => method)).toEqual([
        ...preflightMethods,
        "thread/start",
      ]);
      expect(request.mock.calls.find(([method]) => method === "thread/start")?.[1]).toMatchObject({
        model: requestedModel,
      });
      expect(binding).toMatchObject({
        threadId: "thread-rebound",
        model: requestedModel,
        lifecycle: { action: "started" },
        ...(requestedVersion ? { nativeMultiAgentVersion: requestedVersion } : {}),
      });
    },
  );

  it.each<ColdModelCompatibilityCase>([
    {
      bindingModel: "gpt-5.6-sol",
      requestedModel: "gpt-5.6-terra",
      bindingVersion: undefined,
      requestedVersion: undefined,
    },
    {
      bindingModel: "synthetic-v2-model",
      requestedModel: "synthetic-unclassified-model",
      bindingVersion: "v2",
      requestedVersion: undefined,
    },
    {
      bindingModel: "synthetic-legacy-model",
      requestedModel: "synthetic-v2-model",
      bindingVersion: undefined,
      requestedVersion: "v2",
    },
    {
      bindingModel: "gpt-5.6-sol",
      requestedModel: "synthetic-v1-model",
      bindingVersion: undefined,
      requestedVersion: "v1",
      config: { "agents.enabled": false, "features.multi_agent_v2": false },
    },
  ])(
    "retains the generation through cold resume from $bindingModel to $requestedModel and warm continuation",
    async ({ bindingModel, requestedModel, bindingVersion, requestedVersion, config }) => {
      const sessionFile = path.join(tempDir, `${bindingModel}-${requestedModel}.jsonl`);
      const workspaceDir = path.join(tempDir, "workspace");
      await writeCodexAppServerBinding(sessionFile, {
        threadId: "thread-existing",
        cwd: workspaceDir,
        model: bindingModel,
        ...(bindingVersion ? { nativeMultiAgentVersion: bindingVersion } : {}),
      });
      const params = createParams(sessionFile, workspaceDir);
      params.modelId = requestedModel;
      params.model = {
        ...params.model,
        id: requestedModel,
        params: buildCodexRuntimeModelParams(requestedModel, requestedModel, requestedVersion),
      };
      const respond = createLifecycleRequest(async (method: string, requestParams?: unknown) => {
        if (method === "thread/resume") {
          const response = threadStartResult("thread-existing");
          response.model = (requestParams as { model: string }).model;
          return response;
        }
        throw new Error(`unexpected method: ${method}`);
      });
      const fixture = await createLeasedCodexLifecycleHarness({
        agentDir: path.join(tempDir, "agent"),
        respond,
        persistedThreads: ["thread-existing"],
      });
      const { client, request } = fixture;

      const binding = await startOrResumeThread({
        client,
        params,
        config,
      });

      expect(request.mock.calls.map(([method]) => method)).toEqual(coldResumeMethods);
      expect(request.mock.calls.find(([method]) => method === "thread/resume")?.[1]).toMatchObject({
        threadId: "thread-existing",
        model: requestedModel,
      });
      expect(binding).toMatchObject({
        threadId: "thread-existing",
        model: requestedModel,
        lifecycle: { action: "resumed" },
      });
      expect(binding.nativeMultiAgentVersion).toBe(bindingVersion);
      expect((await readCodexAppServerBinding(sessionFile))?.nativeMultiAgentVersion).toBe(
        bindingVersion,
      );
      await expect(retainThread(client, binding)).resolves.toBe(true);
      params.modelId = bindingModel;
      params.model = {
        ...params.model,
        id: bindingModel,
        params: buildCodexRuntimeModelParams(bindingModel, bindingModel, bindingVersion),
      };

      const continued = await startOrResumeThread({ client, params, config });

      expect(request.mock.calls.map(([method]) => method)).toEqual([
        ...coldResumeMethods,
        ...preflightMethods,
      ]);
      expect(continued).toMatchObject({
        threadId: "thread-existing",
        model: bindingModel,
        lifecycle: { action: "resumed" },
      });
      expect(continued.nativeMultiAgentVersion).toBe(bindingVersion);
      const saved = await readCodexAppServerBinding(sessionFile);
      expect(saved).toMatchObject({ threadId: "thread-existing", model: bindingModel });
      expect(saved?.nativeMultiAgentVersion).toBe(bindingVersion);
    },
  );
}

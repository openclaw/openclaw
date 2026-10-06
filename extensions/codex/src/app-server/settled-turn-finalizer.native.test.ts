import fs from "node:fs/promises";
import path from "node:path";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { loadUserTurnTranscriptRecorderFactoryForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  appendSessionTranscriptMessageByIdentity,
  readVisibleSessionTranscriptMessageEntries,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { describe, expect, it, vi, type MockInstance } from "vitest";
import {
  HOST_KEY,
  HOST_MODEL,
  HOST_PROFILE,
  LIVE,
  NATIVE_KEY,
  NATIVE_MODEL,
  OTHER_PROFILE,
  SUMMARY,
  withNativeFixture,
  type Cleanup,
  type NativeFixture,
} from "../test-support/settled-turn-finalizer.native.js";
import * as authBridge from "./auth-bridge.js";
import { runBoundedCodexAppServerTurn } from "./bounded-turn.js";
import { CodexAppServerClient } from "./client.js";
import {
  resolveCodexAppServerRuntimeOptions,
  resolveCodexSupervisionAppServerRuntimeOptions,
} from "./config.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";
import { assertCodexThreadStartResponse } from "./protocol-validators.js";
import { isJsonObject } from "./protocol.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createCodexRuntimePlanFixture,
  createNativeRunParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import {
  readCodexAppServerBinding,
  registerCodexTestSessionIdentity,
  seedCodexTestBinding,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import * as settledContext from "./settled-turn-context.js";
import { runCodexSettledTurnFinalization } from "./settled-turn-finalizer.js";
import * as sharedClients from "./shared-client.js";
import type { CodexAppServerClientFactory } from "./shared-client.js";
import { runCodexAppServerSideQuestion } from "./side-question.js";
import { attachSqliteSessionTarget } from "./sqlite-session.test-helpers.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

setupRunAttemptTestHooks();

type NativeRunParams = ReturnType<typeof createNativeRunParams>;

async function closeNativeClient(client: CodexAppServerClient): Promise<void> {
  expect(await client.closeAndWait()).toMatchObject({ exited: true });
}

async function writeNativeConfig(
  fixture: NativeFixture,
  codexHome: string,
  provider: "openai" | "settled-fixture",
  nativeFileAuth = false,
) {
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(
    path.join(codexHome, "config.toml"),
    [
      `model=${JSON.stringify(NATIVE_MODEL)}`,
      `model_provider=${JSON.stringify(provider)}`,
      `cli_auth_credentials_store=${JSON.stringify(nativeFileAuth ? "file" : "ephemeral")}`,
      'web_search="disabled"',
      'approval_policy="never"',
      'sandbox_mode="workspace-write"',
      "allow_login_shell=false",
      "[features]",
      "shell_snapshot=false",
      "[analytics]",
      "enabled=false",
      "[feedback]",
      "enabled=false",
      ...(provider === "settled-fixture"
        ? [
            "[model_providers.settled-fixture]",
            'name="Synthetic settled-turn provider"',
            `base_url=${JSON.stringify(fixture.baseUrl)}`,
            'wire_api="responses"',
            "requires_openai_auth=false",
            `experimental_bearer_token=${JSON.stringify(NATIVE_KEY)}`,
            "supports_websockets=false",
            "request_max_retries=0",
            "stream_max_retries=0",
          ]
        : []),
    ].join("\n"),
  );
  if (nativeFileAuth) {
    await fs.writeFile(
      path.join(codexHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: NATIVE_KEY }),
    );
  }
}

async function runNativePrompt(client: CodexAppServerClient, threadId: string, prompt: string) {
  const completed = createDeferred<{ id: string; status: string }>();
  void completed.promise.catch(() => undefined);
  const removeHandler = client.addNotificationHandler((notification) => {
    if (
      notification.method === "turn/completed" &&
      isJsonObject(notification.params) &&
      notification.params.threadId === threadId &&
      isJsonObject(notification.params.turn) &&
      typeof notification.params.turn.id === "string" &&
      typeof notification.params.turn.status === "string"
    ) {
      completed.resolve({
        id: notification.params.turn.id,
        status: notification.params.turn.status,
      });
    }
  });
  const timer = setTimeout(
    () => completed.reject(new Error("Native fixture turn timed out")),
    15_000,
  );
  timer.unref?.();
  try {
    await client.request(
      "turn/start",
      { threadId, input: [{ type: "text", text: prompt, text_elements: [] }] },
      { timeoutMs: 15_000 },
    );
    const turn = await completed.promise;
    expect(turn.status).toBe("completed");
    return turn.id;
  } finally {
    clearTimeout(timer);
    removeHandler();
  }
}

async function createRunParams(fixture: NativeFixture) {
  const params = createNativeRunParams(
    path.join(fixture.root, "session.jsonl"),
    fixture.native.cwd,
  );
  await attachSqliteSessionTarget(
    params,
    path.join(fixture.root, "transcript.sqlite"),
    "settled-native",
  );
  params.agentDir = fixture.agentDir;
  params.prompt = "Record the completed action once.";
  params.provider = "openai";
  params.modelId = NATIVE_MODEL;
  params.model = { ...params.model, id: NATIVE_MODEL, provider: "openai", api: "openai-responses" };
  params.authProfileId = HOST_PROFILE;
  params.authProfileStore = fixture.authProfileStore;
  params.resolvedApiKey = HOST_KEY;
  params.disableTools = false;
  params.permissionMode = "full";
  params.timeoutMs = 20_000;
  params.config = { tools: { web: { search: { enabled: false } } } };
  setCodexTestToolFactory(params, () => []);
  registerCodexTestSessionIdentity(params.sessionFile, params.sessionId, params.sessionKey);
  return params;
}

function usePreparedApiKey(params: NativeRunParams, baseUrl: string) {
  const runtimePlan = createCodexRuntimePlanFixture();
  params.runtimePlan = {
    ...runtimePlan,
    auth: {
      ...runtimePlan.auth,
      providerForAuth: "openai",
      authProfileProviderForAuth: "openai",
      selectedAuthMode: "api-key",
      modelRoute: {
        provider: "openai",
        modelId: params.modelId,
        api: "openai-responses",
        baseUrl,
        authRequirement: "api-key",
        requestTransportOverrides: "none",
      },
    },
  };
}

function transcriptTarget(params: NativeRunParams) {
  return {
    agentId: "main",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey!,
    storePath: params.sessionTarget!.storePath,
  };
}

function trackSharedClient(cleanups: Cleanup[]) {
  let current: CodexAppServerClient | undefined;
  const factory: CodexAppServerClientFactory = async (options) => {
    const client = await sharedClients.getLeasedSharedCodexAppServerClient(options);
    if (client !== current) {
      cleanups.push(async () => {
        await sharedClients.clearSharedCodexAppServerClientIfCurrentAndWait(client);
        await closeNativeClient(client);
      });
      current = client;
    }
    return client;
  };
  return {
    factory,
    client() {
      if (!current) {
        throw new Error("The native attempt did not acquire its shared client");
      }
      return current;
    },
  };
}

// Admission and binding seeding are fixtures, not Gateway/catalog or live OAuth
// proof. Native execution, host auth, settlement, and transcript writes are real;
// Model responses are scripted unless the explicit live fault-injection case is selected.
// This fixture executes /bin/sh; the owner-boundary unit tests are platform-independent.
describe.skipIf(process.platform === "win32")(
  "stock Codex settled-turn finalization ownership",
  () => {
    it.each(["before completion", "after completion"] as const)(
      "settles a bounded turn when the native process closes %s",
      { timeout: 60_000 },
      async (closure) => {
        await withNativeFixture(tempDir, async (fixture, cleanups) => {
          const pluginConfig = {
            ...fixture.pluginConfig,
            appServer: { ...fixture.pluginConfig.appServer, homeScope: "agent" },
          };
          await writeNativeConfig(
            fixture,
            authBridge.resolveCodexAppServerHomeDir(fixture.agentDir),
            "openai",
          );
          fixture.setPhase(closure === "before completion" ? "hold" : "probe");
          // Process/auth startup is setup for the close-event contract below.
          const client = await sharedClients.createIsolatedCodexAppServerClient({
            startOptions: resolveCodexAppServerRuntimeOptions({ pluginConfig }).start,
            authProfileId: HOST_PROFILE,
            authProfileStore: fixture.authProfileStore,
            agentDir: fixture.agentDir,
            timeoutMs: 15_000,
          });
          let settled: Promise<unknown> = Promise.resolve();
          cleanups.push(async () => {
            await closeNativeClient(client);
            await settled;
          });
          if (closure === "after completion") {
            client.addNotificationHandler((notification) => {
              if (notification.method === "turn/completed") {
                // The router receives this native frame synchronously; close before
                // its asynchronous projections run to exercise terminal precedence.
                queueMicrotask(() => client.close());
              }
            });
          }
          const run = runBoundedCodexAppServerTurn({
            model: { mode: "required", id: HOST_MODEL },
            profile: HOST_PROFILE,
            authProfileStore: fixture.authProfileStore,
            agentDir: fixture.agentDir,
            timeoutMs: 15_000,
            taskLabel: "client close proof",
            developerInstructions: "Wait for the answer.",
            input: [{ type: "text", text: "Start the request.", text_elements: [] }],
            requiredModalities: ["text"],
            isolation: "configured-transport",
            requireNoExternalCapabilities: true,
            options: {
              pluginConfig,
              clientFactory: async () => client,
            },
          });
          settled = run.then(
            () => undefined,
            (error: unknown) => error,
          );
          await Promise.race([
            fixture.waitForRequest(),
            settled.then((error) => {
              throw new Error("Bounded turn ended before provider admission", { cause: error });
            }),
          ]);
          if (closure === "before completion") {
            client.close();
            await expect(run).rejects.toThrow("closed");
          } else {
            await expect(run).resolves.toMatchObject({ text: "Ready." });
            expect(client.getCloseError()).toBeDefined();
          }
        });
      },
    );

    it(
      "runs and cancels ephemeral side forks without changing the parent",
      { timeout: 60_000 },
      async () => {
        await withNativeFixture(tempDir, async (fixture, cleanups) => {
          const pluginConfig = {
            ...fixture.pluginConfig,
            appServer: { ...fixture.pluginConfig.appServer, homeScope: "agent" },
          };
          await writeNativeConfig(
            fixture,
            authBridge.resolveCodexAppServerHomeDir(fixture.agentDir),
            "openai",
          );
          const params = await createRunParams(fixture);
          usePreparedApiKey(params, fixture.baseUrl);
          const shared = trackSharedClient(cleanups);
          const initialized = await runCodexAppServerAttempt(
            { ...params, prompt: "Initialize the source." },
            {
              pluginConfig,
              clientFactory: shared.factory,
              nativeHookRelay: { enabled: false },
            },
          );
          expect(initialized.terminal).toEqual({ kind: "ok" });
          const binding = await readCodexAppServerBinding(params.sessionFile);
          if (!binding || !params.runtimePlan) {
            throw new Error("Missing initialized native parent");
          }
          const client = shared.client();
          const before = await client.request("thread/read", {
            threadId: binding.threadId,
            includeTurns: true,
          });
          const transcriptBefore = await readVisibleSessionTranscriptMessageEntries(
            transcriptTarget(params),
          );
          const closeSideHost = await bindProductionHarnessHostCapabilitiesForTest(params);
          cleanups.push(async () => closeSideHost());
          const side = {
            cfg: params.config ?? {},
            agentDir: fixture.agentDir,
            agentId: "main",
            provider: "openai",
            model: NATIVE_MODEL,
            runtimeModel: params.model,
            question: "Record the completed action once.",
            preparedRuntimeAuth: {
              plan: params.runtimePlan.auth,
              authProfileStore: fixture.authProfileStore,
              authStorage: params.authStorage,
              modelRegistry: params.modelRegistry,
              resolvedApiKey: HOST_KEY,
            },
            sessionEntry: {
              sessionId: params.sessionId,
              updatedAt: 1,
              permissionMode: "full" as const,
            },
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            sessionFile: params.sessionFile,
            storePath: params.sessionTarget?.storePath,
            workspaceDir: fixture.native.cwd,
            resolvedReasoningLevel: "off" as const,
            isNewSession: false,
            hostCapabilities: params.hostCapabilities,
          };
          const options = {
            pluginConfig,
            bindingStore: testCodexAppServerBindingStore,
            nativeHookRelay: { enabled: false },
          };
          const calls = vi.spyOn(client, "request");
          fixture.setPhase("side");
          await expect(runCodexAppServerSideQuestion(side, options)).resolves.toEqual({
            text: SUMMARY,
          });
          expect(await fs.readFile(fixture.marker, "utf8")).toBe("completed-once\n");
          const forks = calls.mock.calls.filter(([method]) => method === "thread/fork");
          expect(forks).toHaveLength(1);
          expect(forks[0]?.[1]).toMatchObject({
            threadId: binding.threadId,
            ephemeral: true,
            excludeTurns: true,
          });
          expect(
            (
              await client.request("thread/read", {
                threadId: binding.threadId,
                includeTurns: true,
              })
            ).thread.turns,
          ).toEqual(before.thread.turns);
          expect(
            await readVisibleSessionTranscriptMessageEntries(transcriptTarget(params)),
          ).toEqual(transcriptBefore);
          expect(await readCodexAppServerBinding(params.sessionFile)).toEqual(binding);

          fixture.setPhase("hold");
          const controller = new AbortController();
          const cancelled = runCodexAppServerSideQuestion(
            {
              ...side,
              question: "Wait for cancellation.",
              opts: { abortSignal: controller.signal },
            },
            options,
          );
          const settled = cancelled.then(
            () => undefined,
            (error: unknown) => error,
          );
          try {
            await Promise.race([
              fixture.waitForRequest(),
              settled.then((error) => {
                throw new Error("Side turn ended before provider admission", { cause: error });
              }),
            ]);
            controller.abort("native side cancellation proof");
            await expect(cancelled).rejects.toThrow("aborted");
          } finally {
            controller.abort("native side proof cleanup");
            await settled;
          }
          expect(calls.mock.calls.filter(([method]) => method === "turn/interrupt")).toHaveLength(
            1,
          );
          expect(
            calls.mock.calls.filter(([method]) => method === "thread/unsubscribe"),
          ).toHaveLength(2);
          expect(client.getCloseError()).toBeUndefined();
          fixture.setPhase("health");
          await runNativePrompt(client, binding.threadId, "Confirm the parent still works.");
          expect(fixture.requests).toHaveLength(1);
          expect(await fs.readFile(fixture.marker, "utf8")).toBe("completed-once\n");
        });
      },
    );

    it(
      "refuses supervised finalization even when different host credentials and model work",
      { timeout: 60_000 },
      async () => {
        await withNativeFixture(tempDir, async (fixture, cleanups) => {
          const { native, pluginConfig, agentDir, requests, authProfileStore } = fixture;
          await writeNativeConfig(fixture, native.codexHome, "settled-fixture");
          // A successful private turn makes wrong-account fallback an available path,
          // rather than letting this regression pass only because host auth is broken.
          const hostProbe = await runBoundedCodexAppServerTurn({
            model: { mode: "required", id: HOST_MODEL },
            profile: HOST_PROFILE,
            authProfileStore,
            agentDir,
            timeoutMs: 15_000,
            options: { pluginConfig },
            taskLabel: "host auth proof",
            developerInstructions: "Reply Ready.",
            input: [{ type: "text", text: "Verify the host account.", text_elements: [] }],
            requiredModalities: ["text"],
            isolation: "private-stdio",
            requireNoExternalCapabilities: true,
          });
          expect(hostProbe.text).toBe("Ready.");
          expect(requests.map(({ body, account }) => ({ model: body.model, account }))).toEqual([
            { model: HOST_MODEL, account: `Bearer ${HOST_KEY}` },
          ]);
          fixture.setPhase("probe");
          const appServer = resolveCodexSupervisionAppServerRuntimeOptions({ pluginConfig });
          const sourceClient = await sharedClients.createIsolatedCodexAppServerClient({
            startOptions: appServer.start,
            authProfileId: null,
            agentDir,
            config: {},
            timeoutMs: 15_000,
          });
          cleanups.push(() => closeNativeClient(sourceClient));
          expect(sourceClient.getRuntimeIdentity()?.serverVersion).toBe(CODEX_APP_SERVER_VERSION);
          const source = assertCodexThreadStartResponse(
            await sourceClient.request(
              "thread/start",
              { cwd: native.cwd, dynamicTools: [] },
              { timeoutMs: 15_000 },
            ),
          );
          expect(source.model).toBe(NATIVE_MODEL);
          expect(source.modelProvider).toBe("settled-fixture");
          const sourceTurnId = await runNativePrompt(
            sourceClient,
            source.thread.id,
            "Initialize the source.",
          );
          await sourceClient.request(
            "thread/unsubscribe",
            { threadId: source.thread.id },
            { timeoutMs: 15_000 },
          );
          await closeNativeClient(sourceClient);

          const params = await createRunParams(fixture);
          params.modelId = HOST_MODEL;
          params.model = { ...params.model, id: HOST_MODEL };
          usePreparedApiKey(params, fixture.baseUrl);
          seedCodexTestBinding(params.sessionFile, {
            threadId: source.thread.id,
            cwd: native.cwd,
            connectionScope: "supervision",
            supervisionSourceThreadId: source.thread.id,
            model: source.model,
            modelProvider: source.modelProvider ?? undefined,
            preserveNativeModel: true,
            conversationSourceTransferComplete: true,
            pendingSupervisionBranch: {
              sourceThreadId: source.thread.id,
              lastTurnId: sourceTurnId,
              connectionFingerprint: buildCodexAppServerConnectionFingerprint(appServer, agentDir),
            },
            appServerRuntimeFingerprint: buildCodexAppServerConnectionFingerprint(
              appServer,
              agentDir,
            ),
          });
          const captureContext = vi.spyOn(
            settledContext,
            "captureCodexSettledTurnFinalizationContext",
          );
          const warn = vi.spyOn(embeddedAgentLog, "warn");
          const shared = trackSharedClient(cleanups);
          fixture.setPhase("action");
          const settledAttempt = await runCodexAppServerAttempt(params, {
            pluginConfig,
            clientFactory: shared.factory,
            nativeHookRelay: { enabled: false },
          });
          const client = shared.client();
          expect(settledAttempt.terminal).toEqual({ kind: "ok" });
          expect(settledAttempt.messagesSnapshot).toContainEqual(
            expect.objectContaining({
              role: "toolResult",
              toolCallId: "completed-action",
              isError: false,
            }),
          );
          expect(await fs.readFile(fixture.marker, "utf8")).toBe("completed-once\n");
          expect(requests.map(({ body, account }) => ({ model: body.model, account }))).toEqual([
            { model: NATIVE_MODEL, account: `Bearer ${NATIVE_KEY}` },
            { model: NATIVE_MODEL, account: `Bearer ${NATIVE_KEY}` },
          ]);
          const context = settledAttempt.settledTurnFinalizationContext;
          const sibling = assertCodexThreadStartResponse(
            await client.request(
              "thread/start",
              { cwd: native.cwd, ephemeral: true, dynamicTools: [] },
              { timeoutMs: 15_000 },
            ),
          );
          const before = structuredClone({
            terminal: settledAttempt.terminal,
            messages: settledAttempt.messagesSnapshot,
            tools: settledAttempt.toolMetas,
            lifecycle: settledAttempt.itemLifecycle,
            replay: settledAttempt.replayMetadata,
          });
          const bindingBefore = structuredClone(
            await readCodexAppServerBinding(params.sessionFile),
          );
          const transcriptBefore = await readVisibleSessionTranscriptMessageEntries(
            transcriptTarget(params),
          );
          const sourceIsCurrent = sharedClients.captureSharedCodexAppServerCatalogLifetime(client);
          const nativeRequests = vi.spyOn(client, "request");
          const createClient = vi.spyOn(sharedClients, "createIsolatedCodexAppServerClient");
          const startClient = vi.spyOn(CodexAppServerClient, "start");
          const resolveHandoff = vi.spyOn(authBridge, "resolveCodexAppServerPreparedAuthHandoff");
          const { hostCapabilities: _hostCapabilities, ...attempt } = params;
          fixture.setPhase("summary");
          await expect(
            runCodexSettledTurnFinalization(
              {
                attempt: { ...attempt, prompt: "Summarize the completed action." },
                settledAttempt,
              },
              { pluginConfig },
            ),
          ).rejects.toThrow("Codex settled-turn finalization context is unavailable");
          expect(createClient).not.toHaveBeenCalled();
          expect(startClient).not.toHaveBeenCalled();
          expect(resolveHandoff).not.toHaveBeenCalled();
          expect(nativeRequests).not.toHaveBeenCalled();
          expect(requests).toHaveLength(0);
          expect(context).toEqual({ source: "unavailable" });
          expect(Object.isFrozen(context)).toBe(true);
          expect(captureContext).not.toHaveBeenCalled();
          expect(warn).toHaveBeenCalledWith(
            "codex settled-turn finalization context is unavailable",
            expect.objectContaining({ reason: "native_auth_finalization_unsupported" }),
          );
          expect(settledAttempt.settledTurnFinalizationContext).toBe(context);
          expect({
            terminal: settledAttempt.terminal,
            messages: settledAttempt.messagesSnapshot,
            tools: settledAttempt.toolMetas,
            lifecycle: settledAttempt.itemLifecycle,
            replay: settledAttempt.replayMetadata,
          }).toEqual(before);
          expect(await readCodexAppServerBinding(params.sessionFile)).toEqual(bindingBefore);
          expect(
            await readVisibleSessionTranscriptMessageEntries(transcriptTarget(params)),
          ).toEqual(transcriptBefore);
          expect(sourceIsCurrent()).toBe(true);
          expect(client.getCloseError()).toBeUndefined();
          expect(sharedClients.releaseLeasedSharedCodexAppServerClient(client)).toBe(false);
          await expect(
            client.request(
              "thread/read",
              { threadId: source.thread.id, includeTurns: true },
              { timeoutMs: 15_000 },
            ),
          ).resolves.toMatchObject({
            thread: { id: source.thread.id },
          });
          fixture.setPhase("health");
          await runNativePrompt(client, sibling.thread.id, "Confirm the sibling still works.");
          expect(requests).toHaveLength(1);
          expect(requests[0]?.account).toBe(`Bearer ${NATIVE_KEY}`);
          expect(await fs.readFile(fixture.marker, "utf8")).toBe("completed-once\n");
        });
      },
    );

    it.for([
      {
        label: "ordinary prepared API key",
        homeScope: "agent" as const,
        preserveNativeModel: false,
        prepared: true,
        priorCount: 0,
      },
      {
        label: "preserveNativeModel-only host profile",
        homeScope: "agent" as const,
        preserveNativeModel: true,
        prepared: false,
        priorCount: 0,
      },
      {
        label: "ordinary user-home private host profile",
        homeScope: "user" as const,
        preserveNativeModel: false,
        prepared: false,
        priorCount: 0,
      },
      {
        label: "long conversation",
        homeScope: "agent" as const,
        preserveNativeModel: false,
        prepared: true,
        priorCount: 201,
      },
      {
        label: "hidden background notification",
        homeScope: "agent" as const,
        preserveNativeModel: false,
        prepared: true,
        priorCount: 0,
        hidden: true,
      },
      ...(LIVE
        ? [
            {
              label: "hidden background notification with live provider",
              homeScope: "agent" as const,
              preserveNativeModel: false,
              prepared: true,
              priorCount: 0,
              hidden: true,
              live: true,
            },
          ]
        : []),
    ])(
      "persists a host-authorized summary with the actual native selection ($label)",
      { timeout: LIVE ? 360_000 : 60_000 },
      async (scenario) => {
        const live = "live" in scenario && scenario.live;
        const hidden = "hidden" in scenario && scenario.hidden;
        await withNativeFixture(
          tempDir,
          async (fixture, cleanups) => {
            const pluginConfig = {
              ...fixture.pluginConfig,
              appServer: { ...fixture.pluginConfig.appServer, homeScope: scenario.homeScope },
            };
            const sourceHome =
              scenario.homeScope === "user"
                ? fixture.native.codexHome
                : authBridge.resolveCodexAppServerHomeDir(fixture.agentDir);
            await writeNativeConfig(fixture, sourceHome, "openai", scenario.homeScope === "user");
            const nativeAuthBefore =
              scenario.homeScope === "user"
                ? await fs.readFile(path.join(sourceHome, "auth.json"), "utf8")
                : undefined;
            const params = await createRunParams(fixture);
            if (live) {
              params.timeoutMs = 120_000;
              params.thinkLevel = "low";
            }
            if (scenario.prepared) {
              // The prepared key wins over a usable, differently authenticated profile.
              params.authProfileId = OTHER_PROFILE;
              usePreparedApiKey(params, fixture.baseUrl);
            }
            const shared = trackSharedClient(cleanups);
            const runOptions = {
              pluginConfig,
              clientFactory: shared.factory,
              nativeHookRelay: { enabled: false },
            };
            const initialized = await runCodexAppServerAttempt(
              { ...params, prompt: "Initialize the source." },
              runOptions,
            );
            expect(initialized.terminal).toEqual({ kind: "ok" });
            const initialBinding = await readCodexAppServerBinding(params.sessionFile);
            if (!initialBinding) {
              throw new Error("The ordinary native turn did not commit its binding");
            }
            expect(initialBinding.model).toBe(NATIVE_MODEL);
            expect(initialBinding.connectionScope).not.toBe("supervision");
            if (scenario.preserveNativeModel) {
              seedCodexTestBinding(params.sessionFile, {
                ...initialBinding,
                preserveNativeModel: true,
              });
              params.modelId = HOST_MODEL;
              params.model = { ...params.model, id: HOST_MODEL };
            }
            for (let index = 0; index < scenario.priorCount; index += 1) {
              await appendSessionTranscriptMessageByIdentity({
                ...transcriptTarget(params),
                message: {
                  role: "user",
                  content: `Earlier synthetic request ${index}.`,
                  timestamp: index + 1,
                },
              });
            }
            fixture.setPhase("action");
            params.runId = "run-settled-action";
            if (hidden) {
              params.agentId = "main";
              params.prompt =
                "Background task completed. Use exec_command exactly once to run " +
                "`printf 'completed-once\\n' >> completed-actions.txt; cat completed-actions.txt`, " +
                "then report the command output. Do not run any other command.";
              const createRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
              params.userTurnTranscriptRecorder = createRecorder({
                input: {
                  text: params.prompt,
                  display: false,
                  provenance: {
                    kind: "inter_session",
                    sourceChannel: "internal",
                    sourceTool: "agent_harness_task",
                  },
                  idempotencyKey: "announce:completed-action:user",
                },
                target: { ...transcriptTarget(params), sessionEntry: undefined },
                beforeMessageWrite: ({ message }) => message,
              });
              await params.userTurnTranscriptRecorder.persistApproved();
            }
            const closeHost = await bindProductionHarnessHostCapabilitiesForTest(params);
            cleanups.push(async () => closeHost());
            const settledAttempt = await runCodexAppServerAttempt(params, runOptions);
            expect(settledAttempt.terminal).toEqual({ kind: "ok" });
            const context = settledAttempt.settledTurnFinalizationContext;
            if (!(context instanceof settledContext.CodexSettledTurnContext)) {
              throw new Error("Native turn lost its settled-tool evidence");
            }
            expect(Object.isFrozen(context)).toBe(true);
            if (hidden) {
              expect(context.data).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    role: "user",
                    content: expect.arrayContaining([
                      expect.objectContaining({ text: expect.stringContaining(params.prompt) }),
                    ]),
                  }),
                  expect.objectContaining({ type: "function_call" }),
                  expect.objectContaining({ type: "function_call_output" }),
                ]),
              );
              expect(params.userTurnTranscriptRecorder?.getPersistedMessage?.()).toMatchObject({
                display: false,
                __openclaw: { mirrorIdentity: expect.any(String) },
              });
            }
            expect(() => params.hostCapabilities.assertActive()).not.toThrow();
            closeHost();
            expect(() => params.hostCapabilities.assertActive()).toThrow();
            const sourceKey = scenario.homeScope === "user" ? NATIVE_KEY : HOST_KEY;
            expect(fixture.requests.length).toBeGreaterThan(0);
            for (const { body, account } of fixture.requests) {
              expect({ model: body.model, account }).toEqual({
                model: NATIVE_MODEL,
                account: `Bearer ${sourceKey}`,
              });
            }
            if (!live) {
              expect(fixture.requests).toHaveLength(2);
            }
            expect(await fs.readFile(fixture.marker, "utf8")).toBe("completed-once\n");
            const bindingBefore = structuredClone(
              await readCodexAppServerBinding(params.sessionFile),
            );
            const transcriptBefore = await readVisibleSessionTranscriptMessageEntries(
              transcriptTarget(params),
            );
            if (hidden) {
              expect(
                transcriptBefore.filter(
                  (entry) =>
                    entry.message.role === "user" && entry.message.content === params.prompt,
                ),
              ).toEqual([
                expect.objectContaining({
                  message: expect.objectContaining({
                    display: false,
                    idempotencyKey: "announce:completed-action:user",
                    __openclaw: expect.objectContaining({
                      mirrorIdentity: expect.any(String),
                      runId: params.runId,
                    }),
                  }),
                }),
              ]);
            }
            const sourceClient = shared.client();
            const sourceRequests = vi.spyOn(sourceClient, "request");
            const realCreateClient = sharedClients.createIsolatedCodexAppServerClient;
            let summaryClient: CodexAppServerClient | undefined;
            let summaryRequests: MockInstance<CodexAppServerClient["request"]> | undefined;
            const createClient = vi
              .spyOn(sharedClients, "createIsolatedCodexAppServerClient")
              .mockImplementation(async (options) =>
                realCreateClient({
                  ...options,
                  onStartedClient(client) {
                    summaryClient = client;
                    summaryRequests = vi.spyOn(client, "request");
                    cleanups.push(() => closeNativeClient(client));
                    options?.onStartedClient?.(client);
                  },
                }),
              );
            fixture.setPhase("summary");
            const { hostCapabilities: _hostCapabilities, ...attempt } = params;
            const finalization = await runCodexSettledTurnFinalization(
              {
                attempt: {
                  ...attempt,
                  prompt: live
                    ? "Report the completed command's output. Do not repeat the action."
                    : "Summarize the completed action.",
                },
                settledAttempt,
              },
              { pluginConfig },
            );
            expect(createClient).toHaveBeenCalledOnce();
            expect(summaryClient).not.toBe(sourceClient);
            expect(summaryClient?.getRuntimeIdentity()?.serverVersion).toBe(
              CODEX_APP_SERVER_VERSION,
            );
            expect(sourceRequests).not.toHaveBeenCalled();
            expect(sourceClient.getCloseError()).toBeUndefined();
            expect(
              fixture.requests.map(({ body, account }) => ({ model: body.model, account })),
            ).toEqual([{ model: NATIVE_MODEL, account: `Bearer ${HOST_KEY}` }]);
            expect(fixture.requests[0]?.body.input).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  role: "developer",
                  content: expect.arrayContaining([
                    expect.objectContaining({
                      type: "input_text",
                      text: expect.stringContaining(
                        "Earlier conversation may be omitted; do not infer missing earlier facts.",
                      ),
                    }),
                  ]),
                }),
              ]),
            );
            expect(
              summaryRequests?.mock.calls
                .filter(([method]) => method === "account/login/start")
                .map(([, request]) => request),
            ).toEqual([{ type: "apiKey", apiKey: HOST_KEY }]);
            const startCall = summaryRequests?.mock.calls.find(
              ([method]) => method === "thread/start",
            );
            expect(startCall?.[1]).toMatchObject({
              model: NATIVE_MODEL,
              ephemeral: true,
              environments: [],
              dynamicTools: [],
            });
            expect(
              summaryRequests?.mock.calls.filter(([method]) => method === "thread/inject_items"),
            ).toHaveLength(1);
            const turns = summaryRequests?.mock.calls.filter(([method]) => method === "turn/start");
            expect(turns).toHaveLength(1);
            expect(finalization).toMatchObject({
              assistantTranscriptOwned: true,
              assistant: {
                provider: "openai",
                model: NATIVE_MODEL,
                api: "openai-responses",
                content: [
                  {
                    type: "text",
                    text: live ? expect.stringContaining("completed-once") : SUMMARY,
                  },
                ],
              },
            });
            const transcript = await readVisibleSessionTranscriptMessageEntries(
              transcriptTarget(params),
            );
            expect(transcript.slice(0, transcriptBefore.length)).toEqual(transcriptBefore);
            expect(transcript.slice(transcriptBefore.length).map((entry) => entry.message)).toEqual(
              [finalization.assistant],
            );
            expect(await readCodexAppServerBinding(params.sessionFile)).toEqual(bindingBefore);
            expect(await fs.readFile(fixture.marker, "utf8")).toBe("completed-once\n");
            if (live) {
              expect(fixture.injectedEmptyTerminals()).toBe(1);
              expect(new Set(fixture.livePhases)).toEqual(new Set(["probe", "action", "summary"]));
              for (const { body } of fixture.requests) {
                expect(body.tools ?? []).toEqual([]);
              }
            }
            if (nativeAuthBefore !== undefined) {
              expect(await fs.readFile(path.join(sourceHome, "auth.json"), "utf8")).toBe(
                nativeAuthBefore,
              );
            }
          },
          live,
        );
      },
    );
  },
);

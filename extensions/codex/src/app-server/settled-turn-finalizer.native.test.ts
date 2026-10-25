import fs from "node:fs/promises";
import path from "node:path";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { loadUserTurnTranscriptRecorderFactoryForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  appendSessionTranscriptMessageByIdentity,
  readVisibleSessionTranscriptMessageEntries,
} from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, beforeEach, expect, it, vi, type MockInstance } from "vitest";
import { makeUserMessage } from "../../../test-support/message-fixtures.test-support.js";
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
  type CodexPluginConfig,
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

beforeEach(() => setRuntimeConfigSnapshot({}));
afterEach(() => clearRuntimeConfigSnapshot());

type NativeRunParams = ReturnType<typeof createNativeRunParams>;
type SettledAttempt = Awaited<ReturnType<typeof runCodexAppServerAttempt>>;
const requestOptions = { timeoutMs: 15_000 };

function nativeCase(run: (fixture: NativeFixture, cleanups: Cleanup[]) => Promise<void>) {
  return () => withNativeFixture(tempDir, run);
}

function textInput(text: string) {
  return [{ type: "text" as const, text, text_elements: [] }];
}

function readThread(client: CodexAppServerClient, threadId: string, timed = false) {
  return client.request(
    "thread/read",
    { threadId, includeTurns: true },
    timed ? requestOptions : undefined,
  );
}

async function startThread(client: CodexAppServerClient, cwd: string, ephemeral?: boolean) {
  return assertCodexThreadStartResponse(
    await client.request("thread/start", { cwd, dynamicTools: [], ephemeral }, requestOptions),
  );
}

function attemptSnapshot(attempt: SettledAttempt) {
  const { terminal, messagesSnapshot, toolMetas, itemLifecycle, replayMetadata } = attempt;
  return { terminal, messagesSnapshot, toolMetas, itemLifecycle, replayMetadata };
}

function expectAccounts(fixture: NativeFixture, key: string, count = 1, model = NATIVE_MODEL) {
  const account = { model, account: `Bearer ${key}` };
  expect(requestAccounts(fixture)).toEqual(Array.from({ length: count }, () => account));
}

async function expectActionOnce(fixture: NativeFixture) {
  expect(await fs.readFile(fixture.marker, "utf8")).toBe("completed-once\n");
}

function boundedParams(fixture: NativeFixture, pluginConfig: CodexPluginConfig) {
  return {
    model: { mode: "required" as const, id: HOST_MODEL },
    profile: HOST_PROFILE,
    authProfileStore: fixture.authProfileStore,
    agentDir: fixture.agentDir,
    timeoutMs: 15_000,
    requiredModalities: ["text" as const],
    requireNoExternalCapabilities: true,
    options: { pluginConfig },
  };
}

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
    await client.request("turn/start", { threadId, input: textInput(prompt) }, requestOptions);
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
  params.onSettledTurn = async (attempt, captureContext) => {
    attempt.settledTurnFinalizationContext = await captureContext();
  };
  params.config = { tools: { web: { search: { enabled: false } } } };
  setRuntimeConfigSnapshot(params.config);
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

function readTranscript(params: NativeRunParams) {
  return readVisibleSessionTranscriptMessageEntries(transcriptTarget(params));
}

function callsFor(spy: MockInstance<CodexAppServerClient["request"]> | undefined, method: string) {
  return spy?.mock.calls.filter(([name]) => name === method);
}

function containsObject(...values: Record<string, unknown>[]) {
  return expect.arrayContaining(values.map((value) => expect.objectContaining(value)));
}

function requestAccounts(fixture: NativeFixture) {
  return fixture.requests.map(({ body, account }) => ({ model: body.model, account }));
}

async function configureAgentHome(fixture: NativeFixture): Promise<CodexPluginConfig> {
  await writeNativeConfig(
    fixture,
    authBridge.resolveCodexAppServerHomeDir(fixture.agentDir),
    "openai",
  );
  return {
    ...fixture.pluginConfig,
    appServer: { ...fixture.pluginConfig.appServer, homeScope: "agent" },
  };
}

type SummaryScenario = {
  label: string;
  homeScope?: "agent" | "user";
  preserveNativeModel?: boolean;
  prepared?: boolean;
  priorCount?: number;
  hidden?: boolean;
  promptSuppressed?: boolean;
  live?: boolean;
};

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

async function createRunFixture(
  fixture: NativeFixture,
  cleanups: Cleanup[],
  pluginConfig: CodexPluginConfig,
) {
  const params = await createRunParams(fixture);
  const shared = trackSharedClient(cleanups);
  const options = {
    pluginConfig,
    clientFactory: shared.factory,
    nativeHookRelay: { enabled: false },
  };
  return { params, shared, run: (attempt = params) => runCodexAppServerAttempt(attempt, options) };
}

// Real native/auth/settlement/persistence; scripted model responses except LIVE.
// Admission/binding seeding are fixtures. /bin/sh requires a non-Windows host.
it.skipIf(process.platform === "win32").each(["before completion", "after completion"] as const)(
  "settles a bounded turn when the native process closes %s",
  { timeout: 60_000 },
  async (closure) => {
    await withNativeFixture(tempDir, async (fixture, cleanups) => {
      const pluginConfig = await configureAgentHome(fixture);
      fixture.setPhase(closure === "before completion" ? "hold" : "probe");
      const client = await sharedClients.createIsolatedCodexAppServerClient({
        startOptions: resolveCodexAppServerRuntimeOptions({ pluginConfig }).start,
        authProfileId: HOST_PROFILE,
        authProfileStore: fixture.authProfileStore,
        agentDir: fixture.agentDir,
        timeoutMs: 15_000,
      });
      vi.spyOn(sharedClients, "createIsolatedCodexAppServerClient").mockResolvedValue(client);
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
        ...boundedParams(fixture, pluginConfig),
        taskLabel: "client close proof",
        developerInstructions: "Wait for the answer.",
        input: textInput("Start the request."),
        isolation: "configured-transport",
        options: { pluginConfig },
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

it.skipIf(process.platform === "win32")(
  "runs and cancels ephemeral side forks without changing the parent",
  { timeout: 60_000 },
  nativeCase(async (fixture, cleanups) => {
    const pluginConfig = await configureAgentHome(fixture);
    const { params, shared, run } = await createRunFixture(fixture, cleanups, pluginConfig);
    usePreparedApiKey(params, fixture.baseUrl);
    const initialized = await run({ ...params, prompt: "Initialize the source." });
    expect(initialized.terminal).toEqual({ kind: "ok" });
    const binding = await readCodexAppServerBinding(params.sessionFile);
    if (!binding || !params.runtimePlan) {
      throw new Error("Missing initialized native parent");
    }
    const client = shared.client();
    const before = await readThread(client, binding.threadId);
    const transcriptBefore = await readTranscript(params);
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
      sessionEntry: { sessionId: params.sessionId, updatedAt: 1, permissionMode: "full" as const },
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
    await expect(runCodexAppServerSideQuestion(side, options)).resolves.toMatchObject({
      text: SUMMARY,
    });
    await expectActionOnce(fixture);
    const forks = callsFor(calls, "thread/fork")!;
    expect(forks).toHaveLength(1);
    expect(forks[0]?.[1]).toMatchObject({
      threadId: binding.threadId,
      ephemeral: true,
      excludeTurns: true,
    });
    expect((await readThread(client, binding.threadId)).thread.turns).toEqual(before.thread.turns);
    expect(await readTranscript(params)).toEqual(transcriptBefore);
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
    expect(callsFor(calls, "turn/interrupt")).toHaveLength(1);
    expect(callsFor(calls, "thread/unsubscribe")).toHaveLength(2);
    expect(client.getCloseError()).toBeUndefined();
    fixture.setPhase("health");
    await runNativePrompt(client, binding.threadId, "Confirm the parent still works.");
    expect(fixture.requests).toHaveLength(1);
    await expectActionOnce(fixture);
  }),
);

it.skipIf(process.platform === "win32")(
  "refuses supervised finalization even when different host credentials and model work",
  { timeout: 60_000 },
  nativeCase(async (fixture, cleanups) => {
    const { native, pluginConfig, agentDir, requests } = fixture;
    await writeNativeConfig(fixture, native.codexHome, "settled-fixture");
    // A successful private turn makes wrong-account fallback an available path,
    // rather than letting this regression pass only because host auth is broken.
    const hostProbe = await runBoundedCodexAppServerTurn({
      ...boundedParams(fixture, pluginConfig),
      taskLabel: "host auth proof",
      developerInstructions: "Reply Ready.",
      input: textInput("Verify the host account."),
      isolation: "private-stdio",
    });
    expect(hostProbe.text).toBe("Ready.");
    expectAccounts(fixture, HOST_KEY, 1, HOST_MODEL);
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
    const source = await startThread(sourceClient, native.cwd);
    expect(source).toMatchObject({ model: NATIVE_MODEL, modelProvider: "settled-fixture" });
    const sourceTurnId = await runNativePrompt(
      sourceClient,
      source.thread.id,
      "Initialize the source.",
    );
    await sourceClient.request(
      "thread/unsubscribe",
      { threadId: source.thread.id },
      requestOptions,
    );
    await closeNativeClient(sourceClient);

    const { params, shared, run } = await createRunFixture(fixture, cleanups, pluginConfig);
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
      appServerRuntimeFingerprint: buildCodexAppServerConnectionFingerprint(appServer, agentDir),
    });
    const captureContext = vi.spyOn(settledContext, "captureCodexSettledTurnFinalizationContext");
    const warn = vi.spyOn(embeddedAgentLog, "warn");
    fixture.setPhase("action");
    const settledAttempt = await run();
    const client = shared.client();
    expect(settledAttempt.terminal).toEqual({ kind: "ok" });
    expect(settledAttempt.messagesSnapshot).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        toolCallId: "completed-action",
        isError: false,
      }),
    );
    await expectActionOnce(fixture);
    expectAccounts(fixture, NATIVE_KEY, 2);
    const context = settledAttempt.settledTurnFinalizationContext;
    const sibling = await startThread(client, native.cwd, true);
    const before = structuredClone(attemptSnapshot(settledAttempt));
    const bindingBefore = structuredClone(await readCodexAppServerBinding(params.sessionFile));
    const transcriptBefore = await readTranscript(params);
    const assertSourceCurrent = sharedClients.captureCodexAppServerClientLifetime(
      client,
      "connection",
    );
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
    expect(captureContext).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "codex settled-turn finalization context is unavailable",
      expect.objectContaining({ reason: "native_auth_finalization_unsupported" }),
    );
    expect(settledAttempt.settledTurnFinalizationContext).toBe(context);
    expect(attemptSnapshot(settledAttempt)).toEqual(before);
    expect(await readCodexAppServerBinding(params.sessionFile)).toEqual(bindingBefore);
    expect(await readTranscript(params)).toEqual(transcriptBefore);
    expect(assertSourceCurrent).not.toThrow();
    expect(client.getCloseError()).toBeUndefined();
    expect(sharedClients.releaseLeasedSharedCodexAppServerClient(client)).toBe(false);
    await expect(readThread(client, source.thread.id, true)).resolves.toMatchObject({
      thread: { id: source.thread.id },
    });
    fixture.setPhase("health");
    await runNativePrompt(client, sibling.thread.id, "Confirm the sibling still works.");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.account).toBe(`Bearer ${NATIVE_KEY}`);
    await expectActionOnce(fixture);
  }),
);

it.skipIf(process.platform === "win32").for<SummaryScenario>([
  { label: "ordinary prepared API key" },
  { label: "preserveNativeModel-only host profile", preserveNativeModel: true, prepared: false },
  { label: "ordinary user-home private host profile", homeScope: "user", prepared: false },
  { label: "long conversation", priorCount: 201 },
  { label: "hidden background notification", hidden: true },
  { label: "prompt-less stranded-reply retry", promptSuppressed: true },
  ...(LIVE
    ? [
        { label: "hidden background notification with live provider", hidden: true, live: true },
        {
          label: "prompt-less stranded-reply retry with live provider",
          promptSuppressed: true,
          live: true,
        },
      ]
    : []),
])(
  "persists a host-authorized summary with the actual native selection ($label)",
  { timeout: LIVE ? 360_000 : 60_000 },
  (scenario) =>
    withNativeFixture(
      tempDir,
      (fixture, cleanups) => runSummary(fixture, cleanups, scenario),
      scenario.live,
    ),
);

async function runSummary(
  fixture: NativeFixture,
  cleanups: Cleanup[],
  {
    homeScope = "agent",
    preserveNativeModel = false,
    prepared = true,
    priorCount = 0,
    live = false,
    hidden = false,
    promptSuppressed = false,
  }: SummaryScenario,
) {
  const pluginConfig = {
    ...fixture.pluginConfig,
    appServer: { ...fixture.pluginConfig.appServer, homeScope },
  };
  const sourceHome =
    homeScope === "user"
      ? fixture.native.codexHome
      : authBridge.resolveCodexAppServerHomeDir(fixture.agentDir);
  await writeNativeConfig(fixture, sourceHome, "openai", homeScope === "user");
  const nativeAuthBefore =
    homeScope === "user"
      ? await fs.readFile(path.join(sourceHome, "auth.json"), "utf8")
      : undefined;
  const { params, shared, run } = await createRunFixture(fixture, cleanups, pluginConfig);
  if (live) {
    params.timeoutMs = 120_000;
    params.thinkLevel = "low";
  }
  if (prepared) {
    // The prepared key wins over a usable, differently authenticated profile.
    params.authProfileId = OTHER_PROFILE;
    usePreparedApiKey(params, fixture.baseUrl);
  }
  // Both turns use production process policy with separate run authorities.
  const initialParams = { ...params, prompt: "Initialize the source." };
  const closeInitialHost = await bindProductionHarnessHostCapabilitiesForTest(initialParams);
  cleanups.push(async () => closeInitialHost());
  const initialized = await run(initialParams);
  closeInitialHost();
  expect(initialized.terminal).toEqual({ kind: "ok" });
  const initialBinding = await readCodexAppServerBinding(params.sessionFile);
  if (!initialBinding) {
    throw new Error("The ordinary native turn did not commit its binding");
  }
  expect(initialBinding.model).toBe(NATIVE_MODEL);
  expect(initialBinding.connectionScope).not.toBe("supervision");
  if (preserveNativeModel) {
    seedCodexTestBinding(params.sessionFile, {
      ...initialBinding,
      preserveNativeModel: true,
    });
    params.modelId = HOST_MODEL;
    params.model = { ...params.model, id: HOST_MODEL };
  }
  for (let index = 0; index < priorCount; index += 1) {
    await appendSessionTranscriptMessageByIdentity({
      ...transcriptTarget(params),
      message: makeUserMessage(`Earlier synthetic request ${index}.`, index + 1),
    });
  }
  fixture.setPhase("action");
  params.runId = "run-settled-action";
  if (hidden || promptSuppressed) {
    params.prompt =
      "Background task completed. Use exec_command exactly once to run " +
      "`printf 'completed-once\\n' >> completed-actions.txt; cat completed-actions.txt`, " +
      "then report the command output. Do not run any other command.";
  }
  if (promptSuppressed) {
    // A stranded-reply retry suppresses its system prompt and carries no transcript recorder
    // (src/auto-reply/reply/stranded-reply-recovery.ts), so the turn mirrors no prompt row.
    params.suppressNextUserMessagePersistence = true;
  }
  if (hidden) {
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
  const settledAttempt = await run();
  expect(settledAttempt.terminal).toEqual({ kind: "ok" });
  const context = settledAttempt.settledTurnFinalizationContext;
  if (!(context instanceof settledContext.CodexSettledTurnContext)) {
    throw new Error("Native turn lost its settled-tool evidence");
  }
  if (hidden) {
    expect(context.data).toEqual(
      containsObject(
        {
          role: "user",
          content: containsObject({ text: expect.stringContaining(params.prompt) }),
        },
        { type: "function_call" },
        { type: "function_call_output" },
      ),
    );
    expect(params.userTurnTranscriptRecorder?.getPersistedMessage?.()).toMatchObject({
      display: false,
      __openclaw: { mirrorIdentity: expect.any(String) },
    });
  }
  if (promptSuppressed) {
    expect(context.data).toEqual(
      containsObject({ type: "function_call" }, { type: "function_call_output" }),
    );
    expect(JSON.stringify(context.data)).not.toContain("Background task completed.");
  }
  expect(() => params.hostCapabilities.assertActive()).not.toThrow();
  closeHost();
  expect(() => params.hostCapabilities.assertActive()).toThrow();
  const sourceKey = homeScope === "user" ? NATIVE_KEY : HOST_KEY;
  expect(fixture.requests.length).toBeGreaterThan(0);
  expectAccounts(fixture, sourceKey, fixture.requests.length);
  if (!live) {
    expect(fixture.requests).toHaveLength(2);
  }
  await expectActionOnce(fixture);
  const bindingBefore = structuredClone(await readCodexAppServerBinding(params.sessionFile));
  const transcriptBefore = await readTranscript(params);
  if (hidden) {
    expect(
      transcriptBefore.filter(
        (entry) => entry.message.role === "user" && entry.message.content === params.prompt,
      ),
    ).toMatchObject([
      {
        message: {
          display: false,
          idempotencyKey: "announce:completed-action:user",
          __openclaw: { mirrorIdentity: expect.any(String), runId: params.runId },
        },
      },
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
  expect(summaryClient?.getRuntimeIdentity()?.serverVersion).toBe(CODEX_APP_SERVER_VERSION);
  expect(sourceRequests).not.toHaveBeenCalled();
  expect(sourceClient.getCloseError()).toBeUndefined();
  expectAccounts(fixture, HOST_KEY);
  expect(fixture.requests[0]?.body.input).toEqual(
    containsObject({
      role: "developer",
      content: containsObject({
        type: "input_text",
        text: expect.stringContaining(
          "Earlier conversation may be omitted; do not infer missing earlier facts.",
        ),
      }),
    }),
  );
  expect(callsFor(summaryRequests, "account/login/start")?.map(([, request]) => request)).toEqual([
    { type: "apiKey", apiKey: HOST_KEY },
  ]);
  const startCall = callsFor(summaryRequests, "thread/start")?.[0];
  expect(startCall?.[1]).toMatchObject({
    model: NATIVE_MODEL,
    ephemeral: true,
    environments: [],
    dynamicTools: [],
  });
  expect(callsFor(summaryRequests, "thread/inject_items")).toHaveLength(1);
  expect(callsFor(summaryRequests, "turn/start")).toHaveLength(1);
  expect(finalization).toMatchObject({
    assistantTranscriptOwned: true,
    assistant: {
      provider: "openai",
      model: NATIVE_MODEL,
      api: "openai-responses",
      content: [{ type: "text", text: live ? expect.stringContaining("completed-once") : SUMMARY }],
    },
  });
  const transcript = await readTranscript(params);
  expect(transcript.slice(0, transcriptBefore.length)).toEqual(transcriptBefore);
  expect(transcript.slice(transcriptBefore.length).map((entry) => entry.message)).toEqual([
    finalization.assistant,
  ]);
  expect(await readCodexAppServerBinding(params.sessionFile)).toEqual(bindingBefore);
  await expectActionOnce(fixture);
  if (live) {
    expect(fixture.injectedEmptyTerminals()).toBe(1);
    expect(new Set(fixture.livePhases)).toEqual(new Set(["probe", "action", "summary"]));
    for (const { body } of fixture.requests) {
      expect(body.tools ?? []).toEqual([]);
    }
  }
  if (nativeAuthBefore !== undefined) {
    expect(await fs.readFile(path.join(sourceHome, "auth.json"), "utf8")).toBe(nativeAuthBefore);
  }
}

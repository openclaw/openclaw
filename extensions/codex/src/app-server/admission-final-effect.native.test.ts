// External QA artifact for PR153902 at c511fde70f184c743800cddc0e3941476b9ed5a2.
// Place beside run-attempt.ts only in the disposable, secretless QA checkout.
// Native process/RPC, tool execution and SQLite writes are real. The model's
// Responses SSE, plugin policy and initial host admission are synthetic fixtures.
// This is not hosted-model, Gateway/Slack, official-upgrade or rollout acceptance.
// The preserved admission-request-entry-observer.native.test.ts counted request()
// entries as starts. A locally rejected request entry need not write any RPC bytes.
// This revision observes the real child stdin.write separately, without replacing it.
import fs from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { AgentHarnessSessionSupersededError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { initializeGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import { createPluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-store-runtime";
import {
  createMockPluginRegistry,
  loadUserTurnTranscriptRecorderFactoryForTest,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { getSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  HOST_KEY,
  HOST_PROFILE,
  NATIVE_MODEL,
  withNativeFixture,
  type Cleanup,
  type NativeFixture,
} from "../test-support/settled-turn-finalizer.native.js";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { resolveCodexAppServerHomeDir } from "./auth-bridge.js";
import type { CodexAppServerClient } from "./client.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
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
  createCodexAppServerBindingStore,
  sessionBindingIdentity,
  type StoredCodexAppServerBinding,
} from "./session-binding.js";
import {
  clearSharedCodexAppServerClientIfCurrentAndWait,
  getLeasedSharedCodexAppServerClient,
  type CodexAppServerClientFactory,
} from "./shared-client.js";
import {
  attachSqliteSessionTarget,
  readTranscriptMessagesByIdentity,
} from "./sqlite-session.test-helpers.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

if (process.env.OPENCLAW_LIVE_CODEX_SETTLED_FINALIZATION === "1") {
  throw new Error("This QA artifact requires the synthetic provider; live mode must be off.");
}

setupRunAttemptTestHooks();

type Params = ReturnType<typeof createNativeRunParams>;
type Decision = { outcome: "pass" } | { outcome: "block"; reason: string; message: string };
const PASS: Decision = { outcome: "pass" };
const SAFE_MESSAGE = "Synthetic admission policy denied this request.";
const REJECTED_SENTINEL = "QA_REJECTED_PROMPT_98c46c7d";
const PRIOR_SENTINEL = "QA_PRIOR_NATIVE_HISTORY_a43fd31c";
const TURN_TIMEOUT_MS = 30_000;

function installPolicy(decide: (event: unknown) => Decision | Promise<Decision>) {
  const events: unknown[] = [];
  const endings: unknown[] = [];
  let llmInputs = 0;
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      {
        hookName: "before_agent_run",
        pluginId: "synthetic-admission-policy",
        timeoutMs: TURN_TIMEOUT_MS,
        handler: async (event) => {
          events.push(structuredClone(event));
          return await decide(event);
        },
      },
      {
        hookName: "agent_end",
        handler: (event) => {
          endings.push(structuredClone(event));
        },
      },
      {
        hookName: "llm_input",
        handler: () => {
          llmInputs += 1;
        },
      },
    ]),
  );
  return { events, endings, llmInputs: () => llmInputs };
}

async function configureNativeHome(fixture: NativeFixture) {
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(fixture.root, "state"));
  const nativeHome = resolveCodexAppServerHomeDir(fixture.agentDir);
  for (const scopedPath of [nativeHome, fixture.native.cwd, fixture.native.codexHome]) {
    expect(path.relative(fixture.root, scopedPath)).not.toMatch(/^\.\.(?:[\\/]|$)/);
    expect(path.isAbsolute(path.relative(fixture.root, scopedPath))).toBe(false);
  }
  await fs.mkdir(nativeHome, { recursive: true });
  await fs.writeFile(
    path.join(nativeHome, "config.toml"),
    [
      `model=${JSON.stringify(NATIVE_MODEL)}`,
      'model_provider="openai"',
      'cli_auth_credentials_store="ephemeral"',
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
    ].join("\n"),
  );
}

async function createParams(fixture: NativeFixture, prompt: string, runId: string) {
  const params = createNativeRunParams(
    path.join(fixture.root, "session.jsonl"),
    fixture.native.cwd,
  );
  await attachSqliteSessionTarget(
    params,
    path.join(fixture.root, "transcript.sqlite"),
    "qa-admission",
  );
  params.agentId = "main";
  params.agentDir = fixture.agentDir;
  params.prompt = prompt;
  params.runId = runId;
  params.provider = "openai";
  params.modelId = NATIVE_MODEL;
  params.model = { ...params.model, id: NATIVE_MODEL, provider: "openai", api: "openai-responses" };
  params.authProfileId = HOST_PROFILE;
  params.authProfileStore = fixture.authProfileStore;
  params.resolvedApiKey = HOST_KEY;
  params.disableTools = false;
  params.permissionMode = "full";
  params.timeoutMs = TURN_TIMEOUT_MS;
  params.config = { tools: { web: { search: { enabled: false } } } };
  setCodexTestToolFactory(params, () => []);
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
        modelId: NATIVE_MODEL,
        api: "openai-responses",
        baseUrl: fixture.baseUrl,
        authRequirement: "api-key",
        requestTransportOverrides: "none",
      },
    },
  };
  const makeRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
  params.userTurnTranscriptRecorder = makeRecorder({
    input: { text: prompt, idempotencyKey: `${runId}:user` },
    target: {
      agentId: "main",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey!,
      storePath: params.sessionTarget!.storePath,
      sessionEntry: undefined,
    },
    beforeMessageWrite: ({ message }) => message,
  });
  // Do not pre-approve/persist the input: the actual attempt/transcript owners
  // decide whether to persist the original input or its blocked replacement.
  return params;
}

async function createHarness(fixture: NativeFixture, cleanups: Cleanup[]) {
  await configureNativeHome(fixture);
  const state = createPluginStateSyncKeyedStore<StoredCodexAppServerBinding>("codex", {
    namespace: "qa-native-admission",
    maxEntries: 32,
  });
  const bindingStore = createCodexAppServerBindingStore(state);
  const clients = new Set<CodexAppServerClient>();
  const requestObservers: Array<ReturnType<typeof observeRequests>> = [];
  const writeObservers: Array<ReturnType<typeof observeWrites>> = [];
  const notifications: Array<{ method: string; params?: unknown }> = [];
  let current: CodexAppServerClient | undefined;
  function observeRequests(client: CodexAppServerClient) {
    // Passive observation only: no mockImplementation, mocked responses, fake
    // start function or replacement transport. An entry can reject before write.
    return vi.spyOn(client, "request");
  }
  function observeWrites(client: CodexAppServerClient) {
    // This deliberately inspects the exact pinned client's private transport.
    // Fail loudly if that layout changes; never substitute a surrogate stream.
    const child: unknown = Reflect.get(client, "child");
    if (typeof child !== "object" || child === null) {
      throw new Error("Expected the real native client transport object");
    }
    const stdin: unknown = Reflect.get(child, "stdin");
    if (!(stdin instanceof Writable)) {
      throw new Error("Expected the real native transport stdin Writable");
    }
    return vi.spyOn(stdin, "write");
  }
  const clientFactory: CodexAppServerClientFactory = async (options) => {
    const client = await getLeasedSharedCodexAppServerClient(options);
    current = client;
    if (!clients.has(client)) {
      clients.add(client);
      expect(client.getRuntimeIdentity()?.serverVersion).toBe(CODEX_APP_SERVER_VERSION);
      expect(CODEX_APP_SERVER_VERSION).toBe("0.154.0");
      expect(client.getTransportPid()).toEqual(expect.any(Number));
      requestObservers.push(observeRequests(client));
      writeObservers.push(observeWrites(client));
      const remove = client.addNotificationHandler((notification) => {
        notifications.push({
          method: notification.method,
          params: structuredClone(notification.params),
        });
      });
      cleanups.push(async () => {
        remove();
        await clearSharedCodexAppServerClientIfCurrentAndWait(client);
        expect(await client.closeAndWait()).toMatchObject({ exited: true });
      });
    }
    return client;
  };
  const options = {
    pluginConfig: {
      ...fixture.pluginConfig,
      appServer: { ...fixture.pluginConfig.appServer, homeScope: "agent" },
    },
    bindingStore,
    clientFactory,
    nativeHookRelay: { enabled: false },
  };
  const run = async (params: Params) => {
    const closeHost = await bindProductionHarnessHostCapabilitiesForTest(params);
    try {
      return await runCodexAppServerAttempt(params, options);
    } finally {
      closeHost();
      expect(() => params.hostCapabilities.assertActive()).toThrow();
    }
  };
  const requestEntries = () =>
    requestObservers
      .flatMap((observer) => observer.mock.calls)
      .filter(([method]) => method === "turn/start").length;
  const wireFrames = () =>
    writeObservers
      .flatMap((observer) => observer.mock.calls)
      .flatMap(([chunk]) => {
        // client.writeMessage writes one newline-delimited JSON string. Verify
        // the observed format instead of inferring writes from request entries.
        if (typeof chunk !== "string" || !chunk.endsWith("\n")) {
          throw new Error("Unexpected real native stdin frame encoding");
        }
        return chunk
          .slice(0, -1)
          .split("\n")
          .map((line) => {
            const frame: unknown = JSON.parse(line);
            if (!isJsonObject(frame)) {
              throw new Error("Expected a JSON object on the real native transport");
            }
            return frame;
          });
      });
  const wireStarts = () => wireFrames().filter((frame) => frame.method === "turn/start").length;
  const nativeHistory = async (params: Params) => {
    const binding = bindingStore.read(sessionBindingIdentity(params));
    if (!current || !binding) {
      throw new Error("Expected real native client and committed thread binding");
    }
    // A stalled observation must reject so the fixture can join its native child.
    const history = await current.request(
      "thread/read",
      {
        threadId: binding.threadId,
        includeTurns: true,
      },
      { timeoutMs: TURN_TIMEOUT_MS },
    );
    // Access-time/status fields may change during a valid denied attempt. The
    // canonical thread identity and actual turns are the history invariant.
    const turns = history.thread.turns;
    if (!turns) {
      throw new Error("Expected native turn history after a completed probe");
    }
    return { threadId: history.thread.id, turns };
  };
  return {
    run,
    requestEntries,
    wireStarts,
    nativeHistory,
    notifications,
    clients: () => clients.size,
  };
}

function historyOf(event: unknown): unknown[] {
  if (!isJsonObject(event) || !Array.isArray(event.messages)) {
    throw new Error("Admission did not receive its declared session-history array");
  }
  return event.messages;
}

async function expectNoMarker(fixture: NativeFixture) {
  await expect(fs.stat(fixture.marker)).rejects.toMatchObject({ code: "ENOENT" });
}

async function waitForAdmission(entered: Promise<void>, settled: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      entered,
      settled.then(() => {
        throw new Error("Attempt settled before entering admission");
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Native admission setup timed out")), 25_000);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe.skipIf(process.platform === "win32")(
  "real native admission final effects (synthetic model)",
  () => {
    it(
      "allows one real native turn and executes its physical tool effect once",
      { timeout: 90_000 },
      async () => {
        await withNativeFixture(tempDir, async (fixture, cleanups) => {
          const harness = await createHarness(fixture, cleanups);
          const policy = installPolicy(() => PASS);
          const params = await createParams(
            fixture,
            "Perform the harmless synthetic fixture action once.",
            "qa-pass",
          );
          fixture.setPhase("action");
          const result = await harness.run(params);
          expect(result.terminal).toEqual({ kind: "ok" });
          expect(policy.events).toHaveLength(1);
          expect(policy.llmInputs()).toBe(1);
          expect(harness.clients()).toBe(1);
          expect(harness.requestEntries()).toBe(1);
          expect(harness.wireStarts()).toBe(1);
          expect(fixture.requests).toHaveLength(2);
          expect(await fs.readFile(fixture.marker, "utf8")).toBe("completed-once\n");
          expect(harness.notifications.some(({ method }) => method === "turn/started")).toBe(true);
          expect(harness.notifications.some(({ method }) => method === "turn/completed")).toBe(
            true,
          );
          const history = await harness.nativeHistory(params);
          const commandItems = history.turns
            .flatMap((turn) => turn.items)
            .filter((item) => item.type === "commandExecution");
          expect(commandItems).toHaveLength(1);
          expect(commandItems[0]).toMatchObject({
            status: "completed",
            exitCode: 0,
            aggregatedOutput: expect.stringContaining("completed-once"),
          });
          const transcript = await readTranscriptMessagesByIdentity(params);
          const persistedActionResults = transcript.filter(
            (message) => message.role === "toolResult" && message.toolCallId === "completed-action",
          );
          expect(persistedActionResults).toHaveLength(1);
          expect(persistedActionResults[0]).toEqual(
            expect.objectContaining({
              role: "toolResult",
              toolCallId: "completed-action",
              isError: false,
              content: expect.arrayContaining([
                expect.objectContaining({
                  type: "text",
                  text: expect.stringContaining("completed-once"),
                }),
              ]),
            }),
          );
          expect(params.userTurnTranscriptRecorder?.hasPersisted()).toBe(true);
          console.info(
            "NATIVE_ADMISSION_PROOF",
            JSON.stringify({
              case: "pass",
              version: CODEX_APP_SERVER_VERSION,
              gateCalls: 1,
              requestMethodEntries: harness.requestEntries(),
              turnStartWireWrites: harness.wireStarts(),
              nativeTurnStarted: true,
              providerRequests: fixture.requests.length,
              markerWrites: 1,
              sqliteTranscript: true,
            }),
          );
        });
      },
    );

    it(
      "denies from actual prior native history and persists only the safe replacement",
      { timeout: 90_000 },
      async () => {
        await withNativeFixture(tempDir, async (fixture, cleanups) => {
          const harness = await createHarness(fixture, cleanups);
          const initialPolicy = installPolicy(() => PASS);
          const initial = await createParams(
            fixture,
            `Remember this synthetic history marker: ${PRIOR_SENTINEL}`,
            "qa-history-prime",
          );
          fixture.setPhase("probe");
          expect((await harness.run(initial)).terminal).toEqual({ kind: "ok" });
          expect(initialPolicy.events).toHaveLength(1);
          expect(harness.requestEntries()).toBe(1);
          expect(harness.wireStarts()).toBe(1);
          expect(fixture.requests).toHaveLength(1);
          expect(JSON.stringify(await harness.nativeHistory(initial))).toContain(PRIOR_SENTINEL);
          expect(JSON.stringify(await readTranscriptMessagesByIdentity(initial))).toContain(
            PRIOR_SENTINEL,
          );
          const originalNativeHistory = JSON.stringify(await harness.nativeHistory(initial));
          const policy = installPolicy((event) =>
            JSON.stringify(historyOf(event)).includes(PRIOR_SENTINEL)
              ? {
                  outcome: "block",
                  reason: "synthetic prior-history policy",
                  message: SAFE_MESSAGE,
                }
              : PASS,
          );
          const blocked = await createParams(fixture, REJECTED_SENTINEL, "qa-history-block");
          fixture.setPhase("action");
          const beforeEntries = harness.requestEntries();
          const beforeWireStarts = harness.wireStarts();
          const result = await harness.run(blocked);
          expect(readAttemptTerminal(result).promptErrorSource).toBe("hook:before_agent_run");
          expect(policy.events).toHaveLength(1);
          expect(JSON.stringify(historyOf(policy.events[0]))).toContain(PRIOR_SENTINEL);
          expect(policy.llmInputs()).toBe(0);
          expect(policy.endings).toHaveLength(1);
          expect(harness.requestEntries()).toBe(beforeEntries);
          expect(harness.wireStarts()).toBe(beforeWireStarts);
          expect(fixture.requests).toHaveLength(0);
          await expectNoMarker(fixture);
          const transcript = await readTranscriptMessagesByIdentity(blocked);
          expect(JSON.stringify(transcript)).toContain(PRIOR_SENTINEL);
          expect(JSON.stringify(transcript)).toContain(SAFE_MESSAGE);
          expect(JSON.stringify(transcript)).not.toContain(REJECTED_SENTINEL);
          expect(blocked.userTurnTranscriptRecorder?.isBlocked()).toBe(true);
          expect(blocked.userTurnTranscriptRecorder?.hasPersisted()).toBe(true);
          expect(JSON.stringify(result.messagesSnapshot)).not.toContain(REJECTED_SENTINEL);
          expect(JSON.stringify(policy.endings)).not.toContain(REJECTED_SENTINEL);
          const nativeHistory = JSON.stringify(await harness.nativeHistory(blocked));
          expect(nativeHistory).not.toContain(REJECTED_SENTINEL);
          expect(nativeHistory).toBe(originalNativeHistory);
          console.info(
            "NATIVE_ADMISSION_PROOF",
            JSON.stringify({
              case: "history-denial",
              version: CODEX_APP_SERVER_VERSION,
              gateCalls: 1,
              additionalRequestMethodEntries: harness.requestEntries() - beforeEntries,
              additionalTurnStartWireWrites: harness.wireStarts() - beforeWireStarts,
              providerRequests: 0,
              markerWrites: 0,
              sqliteSafeReplacement: true,
              nativeHistoryUnchanged: true,
            }),
          );
        });
      },
    );

    it.each(["pass", "block"] as const)(
      "starts nothing when cancellation wins a pending %s decision",
      { timeout: 90_000 },
      async (decision) => {
        await withNativeFixture(tempDir, async (fixture, cleanups) => {
          const harness = await createHarness(fixture, cleanups);
          const entered = createDeferred<void>();
          const pending = createDeferred<Decision>();
          const policy = installPolicy(() => {
            entered.resolve();
            return pending.promise;
          });
          const params = await createParams(fixture, REJECTED_SENTINEL, `qa-cancel-${decision}`);
          const abort = new AbortController();
          params.abortSignal = abort.signal;
          fixture.setPhase("action");
          const run = harness.run(params);
          const settled = run.then(
            (result) => ({ result }),
            (error: unknown) => ({ error }),
          );
          try {
            await waitForAdmission(entered.promise, settled);
            expect(harness.clients()).toBe(1);
            expect(policy.events).toHaveLength(1);
            expect(harness.requestEntries()).toBe(0);
            expect(harness.wireStarts()).toBe(0);
            expect(fixture.requests).toHaveLength(0);
            const reason = new Error("Synthetic cancellation while admission is pending");
            abort.abort(reason);
            pending.resolve(
              decision === "pass"
                ? PASS
                : { outcome: "block", reason: "synthetic denial", message: SAFE_MESSAGE },
            );
            const outcome = await settled;
            expect("error" in outcome ? outcome.error : undefined).toBe(reason);
            expect(harness.requestEntries()).toBe(0);
            expect(harness.wireStarts()).toBe(0);
            expect(policy.llmInputs()).toBe(0);
            expect(fixture.requests).toHaveLength(0);
            await expectNoMarker(fixture);
            expect(await readTranscriptMessagesByIdentity(params)).toEqual([]);
            expect(params.userTurnTranscriptRecorder?.hasPersisted()).toBe(false);
            expect(params.userTurnTranscriptRecorder?.isBlocked()).toBe(false);
            console.info(
              "NATIVE_ADMISSION_PROOF",
              JSON.stringify({
                case: `cancel-${decision}`,
                version: CODEX_APP_SERVER_VERSION,
                gateCalls: policy.events.length,
                requestMethodEntries: harness.requestEntries(),
                turnStartWireWrites: harness.wireStarts(),
                providerRequests: 0,
                markerWrites: 0,
              }),
            );
          } finally {
            abort.abort(new Error("Synthetic test cleanup"));
            pending.resolve(PASS);
            await settled;
          }
        });
      },
    );

    it(
      "rejects a stale attempt after the canonical session owner is replaced during admission",
      { timeout: 90_000 },
      async () => {
        await withNativeFixture(tempDir, async (fixture, cleanups) => {
          const harness = await createHarness(fixture, cleanups);
          // A never-run native thread cannot supply includeTurns history. Prime one
          // actual native turn, then retain its native and SQLite evidence before
          // the second attempt reaches the deliberately pending admission policy.
          const initialPolicy = installPolicy(() => PASS);
          const initial = await createParams(
            fixture,
            `Remember this synthetic owner-history marker: ${PRIOR_SENTINEL}`,
            "qa-owner-prime",
          );
          fixture.setPhase("probe");
          expect((await harness.run(initial)).terminal).toEqual({ kind: "ok" });
          expect(initialPolicy.events).toHaveLength(1);
          expect(harness.requestEntries()).toBe(1);
          expect(harness.wireStarts()).toBe(1);
          expect(fixture.requests).toHaveLength(1);
          expect(harness.notifications.some(({ method }) => method === "turn/started")).toBe(true);
          const originalNativeHistory = structuredClone(await harness.nativeHistory(initial));
          const originalTranscript = structuredClone(
            await readTranscriptMessagesByIdentity(initial),
          );
          expect(JSON.stringify(originalNativeHistory)).toContain(PRIOR_SENTINEL);
          expect(JSON.stringify(originalTranscript)).toContain(PRIOR_SENTINEL);
          await expectNoMarker(fixture);
          const beforeEntries = harness.requestEntries();
          const beforeWireStarts = harness.wireStarts();
          const beforeNotifications = harness.notifications.length;
          const entered = createDeferred<void>();
          const pending = createDeferred<Decision>();
          const policy = installPolicy(() => {
            entered.resolve();
            return pending.promise;
          });
          const params = await createParams(fixture, REJECTED_SENTINEL, "qa-owner-replacement");
          const abort = new AbortController();
          params.abortSignal = abort.signal;
          fixture.setPhase("action");
          const run = harness.run(params);
          const settled = run.then(
            (result) => ({ result }),
            (error: unknown) => ({ error }),
          );
          try {
            await waitForAdmission(entered.promise, settled);
            expect(harness.clients()).toBe(1);
            expect(policy.events).toHaveLength(1);
            expect(JSON.stringify(historyOf(policy.events[0]))).toContain(PRIOR_SENTINEL);
            expect(harness.requestEntries()).toBe(beforeEntries);
            expect(harness.wireStarts()).toBe(beforeWireStarts);
            expect(fixture.requests).toHaveLength(0);
            const replacementSessionId = "qa-admission-successor";
            // Inject the canonical ownership fact using the real session store.
            // This is the generation fence, not a complete Gateway reset workflow.
            await upsertSessionEntry({
              agentId: "main",
              sessionKey: params.sessionKey!,
              storePath: params.sessionTarget!.storePath,
              entry: {
                sessionId: replacementSessionId,
                previousSessionId: params.sessionId,
                updatedAt: Date.now(),
              },
            });
            expect(
              getSessionEntry({
                agentId: "main",
                sessionKey: params.sessionKey!,
                storePath: params.sessionTarget!.storePath,
                readConsistency: "latest",
              })?.sessionId,
            ).toBe(replacementSessionId);
            pending.resolve(PASS);
            const outcome = await settled;
            if ("result" in outcome) {
              expect(outcome.result.terminal.kind).not.toBe("ok");
            }
            const superseded =
              "result" in outcome ? readAttemptTerminal(outcome.result).promptError : outcome.error;
            expect(superseded).toBeInstanceOf(AgentHarnessSessionSupersededError);
            expect(superseded).toMatchObject({
              name: "AgentHarnessSessionSupersededError",
              message: `Codex session generation is no longer current: ${params.sessionId}`,
            });
            expect(policy.events).toHaveLength(1);
            // One request() entry is expected: the real client's synchronous
            // assertCurrent rejects it before writeMessage reaches child stdin.
            expect(harness.requestEntries() - beforeEntries).toBe(1);
            expect(harness.wireStarts()).toBe(beforeWireStarts);
            expect(fixture.requests).toHaveLength(0);
            expect(
              harness.notifications
                .slice(beforeNotifications)
                .some(({ method }) => method === "turn/started"),
            ).toBe(false);
            await expectNoMarker(fixture);
            const transcript = await readTranscriptMessagesByIdentity(params);
            expect(transcript).toEqual(originalTranscript);
            expect(JSON.stringify(transcript)).not.toContain(REJECTED_SENTINEL);
            expect(params.userTurnTranscriptRecorder?.hasPersisted()).toBe(false);
            const nativeHistory = await harness.nativeHistory(params);
            expect(nativeHistory).toEqual(originalNativeHistory);
            expect(JSON.stringify(nativeHistory)).not.toContain(REJECTED_SENTINEL);
            console.info(
              "NATIVE_ADMISSION_PROOF",
              JSON.stringify({
                case: "canonical-owner-replaced",
                version: CODEX_APP_SERVER_VERSION,
                gateCalls: 1,
                additionalRequestMethodEntries: harness.requestEntries() - beforeEntries,
                additionalTurnStartWireWrites: harness.wireStarts() - beforeWireStarts,
                nativeTurnStarted: false,
                providerRequests: 0,
                markerWrites: 0,
                supersededErrorName: "AgentHarnessSessionSupersededError",
                nativeHistoryUnchanged: true,
                sqliteHistoryUnchanged: true,
              }),
            );
          } finally {
            abort.abort(new Error("Synthetic test cleanup"));
            pending.resolve(PASS);
            await settled;
          }
        });
      },
    );
  },
);

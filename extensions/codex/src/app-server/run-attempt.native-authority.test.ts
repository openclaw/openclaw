import path from "node:path";
import { patchSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import { isJsonObject, type RpcRequest } from "./protocol.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createParams,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setCodexAppServerClientFactoryForTest,
  threadStartResult,
  turnStartResult,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { testCodexAppServerBindingStore } from "./session-binding.test-helpers.js";
import { getLeasedSharedCodexAppServerClient } from "./shared-client.js";
import { runCodexAppServerSideQuestion } from "./side-question.js";
import { createLeasedCodexLifecycleHarness } from "./thread-lifecycle.test-fixtures.js";

setupRunAttemptTestHooks();

it.each([
  { operation: "start", transition: "allowed", boundary: "thread/start" },
  { operation: "start", transition: "revoked", boundary: "thread/start" },
  { operation: "start", transition: "reassigned", boundary: "thread/start" },
  { operation: "start", transition: "revoked", boundary: "turn/start" },
  { operation: "start", transition: "reassigned", boundary: "turn/start" },
  { operation: "resume", transition: "allowed", boundary: "thread/resume" },
  { operation: "resume", transition: "revoked", boundary: "thread/resume" },
  { operation: "resume", transition: "reassigned", boundary: "thread/resume" },
  { operation: "btw", transition: "allowed", boundary: "thread/fork" },
  { operation: "btw", transition: "revoked", boundary: "thread/fork" },
  { operation: "btw", transition: "reassigned", boundary: "thread/fork" },
  { operation: "btw", transition: "revoked", boundary: "turn/start" },
  { operation: "btw", transition: "reassigned", boundary: "turn/start" },
] as const)(
  "keeps native $operation dispatch bound to the $transition requester at $boundary",
  async ({ operation, transition, boundary }) => {
    const params = createParams(path.join(tempDir, "session.jsonl"), tempDir, {
      sessionKey: "agent:main:dashboard:native-authority",
      provider: "openai",
      prompt: "Use native workspace tools for the synthetic authority fixture.",
    });
    params.config = { tools: { web: { search: { enabled: false } } } };
    setCodexTestModelSupportsTools(params, true);
    setCodexTestToolFactory(params, () => []);
    const scope = {
      agentId: "main",
      sessionKey: params.sessionKey!,
      storePath: resolveStorePath(undefined, { agentId: "main" }),
    };
    await patchSessionEntry({
      ...scope,
      fallbackEntry: { sessionId: params.sessionId, updatedAt: 1 },
      update: () => ({
        spawnedBy: "agent:main:parent",
        spawnDepth: 1,
        inheritedToolPolicyVersion: 1,
        inheritedToolAllow: [],
        inheritedToolDeny: [],
      }),
    });
    const close = await bindProductionHarnessHostCapabilitiesForTest(params);
    const host = params.hostCapabilities;
    let transitioned = false;
    let sideQuestionRunning = false;
    const harness = await createLeasedCodexLifecycleHarness({
      agentDir: path.join(tempDir, "wire-agent"),
      respond: (method) => {
        if (method === "thread/start" || method === "thread/resume") {
          return threadStartResult();
        }
        if (method === "thread/fork") {
          const response = threadStartResult("side-thread");
          harness.seed(response, { loaded: true, subscribed: true });
          return response;
        }
        if (method === "turn/start") {
          if (sideQuestionRunning) {
            queueMicrotask(() => {
              harness.notify({
                method: "item/agentMessage/delta",
                params: {
                  threadId: "side-thread",
                  turnId: "turn-1",
                  itemId: "answer",
                  delta: "Side answer.",
                },
              });
              completeTurn("side-thread");
            });
          }
          return turnStartResult();
        }
        if (method === "modelProvider/capabilities/read") {
          return { imageGeneration: false, webSearch: true };
        }
        if (method === "config/read") {
          return { config: {}, origins: {}, layers: [] };
        }
        if (method === "skills/list" || method === "thread/backgroundTerminals/list") {
          return { data: [], nextCursor: null };
        }
        if (method === "configRequirements/read") {
          return { requirements: null };
        }
        return {};
      },
    });
    vi.spyOn(CodexAppServerClient, "start").mockResolvedValue(harness.client);
    setCodexAppServerClientFactoryForTest(async (_start, _auth, _dir, _config, options) =>
      getLeasedSharedCodexAppServerClient({
        ...options,
        ...harness.acquireOptions,
        preparedAuth: undefined,
        authRequirement: undefined,
      }),
    );
    const completeTurn = (threadId: string) =>
      harness.notify({
        method: "turn/completed",
        params: { threadId, turn: { id: "turn-1", status: "completed", items: [] } },
      });
    const runAttempt = async () => {
      const run = runCodexAppServerAttempt(params);
      const complete = run.waitForTurnAccepted().then(
        () => completeTurn("thread-1"),
        () => {},
      );
      try {
        return await run;
      } finally {
        await complete;
      }
    };
    if (operation !== "start") {
      await runAttempt();
      if (operation === "resume") {
        await harness.client.request("thread/unsubscribe", { threadId: "thread-1" });
      }
      harness.writes.length = 0;
    }
    const dispatch = CodexAppServerClient.prototype.request.bind(harness.client);
    harness.request.mockImplementation((method, body, options) => {
      if (method !== boundary) {
        return dispatch(method, body, options);
      }
      return dispatch(method, body, {
        ...options,
        withCurrent: async (write) => {
          if (!transitioned) {
            transitioned = true;
            if (transition !== "allowed") {
              await patchSessionEntry({
                ...scope,
                update: () =>
                  transition === "revoked"
                    ? { inheritedToolDeny: ["exec"] }
                    : { spawnedBy: "agent:main:other-parent" },
              });
            }
            // Preparation has finished; the attempt stays live at the wire admission gate.
            host.assertActive();
          }
          if (options?.withCurrent) {
            await options.withCurrent(write);
          } else {
            write();
          }
        },
      });
    });
    sideQuestionRunning = operation === "btw";
    const run =
      operation === "btw"
        ? runCodexAppServerSideQuestion(
            {
              cfg: params.config,
              agentDir: path.join(tempDir, "wire-agent"),
              agentId: "main",
              provider: params.provider,
              model: params.modelId,
              runtimeModel: params.model,
              question: "Answer the synthetic side question.",
              sessionEntry: { sessionId: params.sessionId, updatedAt: 1 },
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
              sessionFile: params.sessionFile,
              storePath: scope.storePath,
              workspaceDir: tempDir,
              isNewSession: false,
              resolvedReasoningLevel: "off",
              hostCapabilities: params.hostCapabilities,
              preparedRuntimeAuth: {
                resolvedApiKey: "synthetic-native-authority-key",
                plan: {
                  providerForAuth: "openai",
                  authProfileProviderForAuth: "openai",
                  selectedAuthMode: "api-key",
                  modelRoute: {
                    provider: "openai",
                    modelId: params.modelId,
                    api: "openai-responses",
                    baseUrl: "https://api.openai.com/v1",
                    authRequirement: "api-key",
                    requestTransportOverrides: "none",
                  },
                },
                authStorage: params.authStorage,
                authProfileStore: params.authProfileStore,
                modelRegistry: params.modelRegistry,
              },
            },
            { bindingStore: testCodexAppServerBindingStore, nativeHookRelay: { enabled: false } },
          )
        : runAttempt();
    try {
      const outcome = await run.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      const requests = harness.writes.map((line) => JSON.parse(line) as RpcRequest);
      const starts = requests.filter(
        (request) =>
          request.method ===
          (operation === "start"
            ? "thread/start"
            : operation === "resume"
              ? "thread/resume"
              : "thread/fork"),
      );
      const turns = requests.filter((request) => request.method === "turn/start");
      console.log(
        `[authority-chain] boundary=${boundary} requester=${transition} host=active native-thread-writes=${starts.length} native-turn-writes=${turns.length} outcome=${"error" in outcome ? "rejected" : "completed"}`,
      );
      expect(transitioned, "error" in outcome ? String(outcome.error) : undefined).toBe(true);
      if (transition === "allowed" || boundary === "turn/start") {
        expect(starts[0]?.params).toMatchObject({ config: { web_search: "disabled" } });
      }
      if (transition === "allowed") {
        expect(outcome).not.toHaveProperty("error");
        expect(starts).toHaveLength(1);
        expect(turns).toHaveLength(1);
        expect(isJsonObject(turns[0]?.params) && turns[0].params.input).toBeTruthy();
      } else {
        expect(outcome).toHaveProperty("error");
        if ("error" in outcome) {
          expect(outcome.error).toMatchObject({
            message: expect.stringMatching(/policy changed|superseded|no longer active/),
          });
        }
        expect(starts).toHaveLength(boundary === "turn/start" ? 1 : 0);
        expect(turns).toEqual([]);
      }
    } finally {
      close();
    }
  },
);

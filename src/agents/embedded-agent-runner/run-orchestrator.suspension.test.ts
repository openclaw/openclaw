import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createAssistantMessageEventStream, type Context } from "openclaw/plugin-sdk/llm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly as loadSessionEntry,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { hasOpenClawAgentDatabaseAsyncResources } from "../../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseByPathAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import {
  runWithDeferredSessionSuspension,
  suspendSession,
  type SessionSuspensionParams,
} from "../session-suspension.js";
import { SessionManager } from "../sessions/index.js";
import {
  buildEmbeddedRunnerAssistant,
  createEmbeddedAgentRunnerOpenAiConfig,
  createMockUsage,
  createResolvedEmbeddedRunnerModel,
  immediateEnqueue,
  makeEmbeddedRunnerAttempt,
} from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import {
  installEmbeddedRunnerBaseE2eMocks,
  installEmbeddedRunnerFastRunE2eMocks,
} from "../test-helpers/embedded-agent-runner-e2e-mocks.js";
import { withTestAdmission } from "./run-orchestrator.test-support.js";
import type { EmbeddedRunAttemptParams, EmbeddedRunAttemptResult } from "./run/types.js";

const tempRoots = createTempDirTracker();
const runAttempt = vi.fn<(params: EmbeddedRunAttemptParams) => Promise<EmbeddedRunAttemptResult>>();
const summaryStream = vi.fn();
const assistant = (text: string) =>
  buildEmbeddedRunnerAssistant({ content: [{ type: "text", text }] });
const verified = { payloads: [{ text: "Verified." }] };
const billingFailure = { reason: "billing", suspend: true };
type ProductionRun = typeof import("./run.js").runEmbeddedAgent;
let runEmbeddedAgent: ProductionRun;
let acquireRuntime: typeof import("../prepared-model-runtime.js").acquireAgentRunPreparedModelRuntime;
let runWithModelFallback: typeof import("../model-fallback-runner.js").runWithModelFallback;

beforeAll(async () => {
  installEmbeddedRunnerBaseE2eMocks();
  installEmbeddedRunnerFastRunE2eMocks({ runEmbeddedAttempt: runAttempt });
  vi.doUnmock("../runtime-plan/build.js");
  vi.doUnmock("../../plugins/provider-runtime.js");
  vi.doUnmock("../../plugins/provider-hook-runtime.js");
  vi.doMock("../models-config.js", () => ({ ensureOpenClawModelsJson: vi.fn() }));
  vi.doMock("./model.js", async () => {
    const { AuthStorage, ModelRegistry } = await import("../sessions/index.js");
    return {
      resolveModelAsync: async (provider: string, modelId: string) => {
        const resolved = createResolvedEmbeddedRunnerModel(provider, modelId);
        const authStorage = AuthStorage.inMemory();
        authStorage.setRuntimeApiKey(provider, "synthetic-compaction-key");
        const modelRegistry = ModelRegistry.inMemory(authStorage);
        return { ...resolved, authStorage, modelRegistry };
      },
    };
  });
  ({ acquireAgentRunPreparedModelRuntime: acquireRuntime } =
    await import("../prepared-model-runtime.js"));
  const { runEmbeddedAgent: run } = await import("./run.js");
  const { prepareSystemAgentRunAdmission } = await import("../admitted-run-context.js");
  runEmbeddedAgent = withTestAdmission(run, prepareSystemAgentRunAdmission, "suspension-test");
  ({ runWithModelFallback } = await import("../model-fallback-runner.js"));
});

beforeEach(async () => {
  runAttempt.mockReset();
  summaryStream.mockReset();
  const providerRuntime = await import("../../plugins/provider-runtime.js");
  vi.spyOn(providerRuntime, "resolveProviderStreamFn").mockReturnValue(summaryStream);
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("Unexpected network request in detached compaction proof");
  });
});

async function joinSuspensionWrites() {
  // A no-config request joins the production FIFO without looking up a session.
  await suspendSession({
    cfg: undefined,
    sessionId: "queue-barrier",
    reason: "manual",
    failedProvider: "openai",
    failedModel: "mock-1",
  });
}

async function closeAgentDatabases() {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
}

const expectAbsent = async (file: string) => expect(fs.access(file)).rejects.toThrow();

afterEach(async () => {
  await joinSuspensionWrites();
  // Worker lease release still needs the fixture's shared-state database.
  await closeAgentDatabases();
  for (const root of tempRoots.dirs) {
    await closeOpenClawStateDatabaseByPathAsync(
      resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: path.join(root, "final") }),
    );
  }
  closeOpenClawStateDatabaseForTest();
  clearRuntimeConfigSnapshot();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  expect(
    hasOpenClawAgentDatabaseAsyncResources(),
    "fixture workers must settle before root deletion",
  ).toBe(false);
  tempRoots.cleanup();
});

afterAll(async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
});

async function createRun(sessionPersistence?: "durable" | "detached", agentId = "research") {
  const root = tempRoots.make("openclaw-suspension-boundary-");
  const stateDir = path.join(root, "final");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const agentDir = path.join(root, "staged", "agents", agentId, "agent");
  const workspaceDir = path.join(root, "workspace");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(workspaceDir, { recursive: true });
  const config = createEmbeddedAgentRunnerOpenAiConfig(["mock-1", "mock-2"]);
  config.agents = {
    ownership: "explicit",
    entries: { main: {}, research: {} },
    defaults: { model: { primary: "openai/mock-1", fallbacks: ["openai/mock-2"] } },
  };
  setRuntimeConfigSnapshot(config);
  const sessionId = "setup-inference-probe";
  const sessionKey = `agent:${agentId}:setup-inference:incognito-probe`;
  const params = {
    agentId,
    agentDir,
    workspaceDir,
    config,
    sessionId,
    sessionKey,
    sessionPersistence,
    sessionManager: SessionManager.inMemory(workspaceDir),
    prompt: "Reply briefly.",
    provider: "openai",
    model: "mock-1",
    timeoutMs: 5_000,
    runId: `suspension-${agentId}`,
    enqueue: immediateEnqueue,
  };
  const scope = {
    agentId,
    sessionKey,
    storePath: resolveSessionStorePathCore(config.session?.store, { agentId }),
  };
  return {
    params,
    scope,
    database: path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite"),
    seed: (entry: Parameters<typeof upsertSessionEntryCore>[1] = {}) =>
      upsertSessionEntryCore(scope, { sessionId, updatedAt: 1, ...entry }),
    expectNoAgent: () => expectAbsent(path.join(stateDir, "agents")),
    run: (overrides: Partial<Parameters<ProductionRun>[0]> = {}) =>
      runEmbeddedAgent({ ...params, ...overrides }),
  };
}

function successfulAttempt(sessionId: string, text = "Verified.") {
  return makeEmbeddedRunnerAttempt({
    sessionIdUsed: sessionId,
    assistantTexts: [text],
    lastAssistant: assistant(text),
  });
}

const pendingSwitch = (modelOverride = "mock-2") => ({
  providerOverride: "openai",
  modelOverride,
  liveModelSwitchPending: true,
});

function failAttempt(stage: "prompt" | "assistant", sessionId: string) {
  const message = stage === "prompt" ? "rate limit exceeded" : "insufficient credits";
  runAttempt.mockResolvedValue(
    makeEmbeddedRunnerAttempt({
      sessionIdUsed: sessionId,
      providerRetryMaxRetries: 0,
      ...(stage === "prompt"
        ? { terminal: { kind: "failed", source: "prompt", error: new Error(message) } }
        : {
            lastAssistant: buildEmbeddedRunnerAssistant({
              stopReason: "error",
              errorMessage: message,
            }),
          }),
    }),
  );
}

describe("embedded run detached session metadata", () => {
  it("preserves caller ownership and fills only missing failure-suspension agent ids", async () => {
    const { params } = await createRun();
    const requests: SessionSuspensionParams[] = [];
    const runtime = await import("./run/prepared-runtime-context.js");
    const bind = runtime.bindRunToPreparedModelRuntime;
    let boundParams: ReturnType<typeof bind>["runParams"] | undefined;
    vi.spyOn(runtime, "bindRunToPreparedModelRuntime").mockImplementation((input) => {
      const bound = bind(input);
      boundParams = bound.runParams;
      return bound;
    });
    const loop = await import("./run-loop.js");
    vi.spyOn(loop, "runPreparedEmbeddedLoop").mockImplementation(async (_refresh, input) => {
      assert(boundParams, "Expected the run's prepared identity");
      const suspension: SessionSuspensionParams = {
        cfg: undefined,
        sessionId: params.sessionId,
        reason: "quota_exhausted",
        failedProvider: "openai",
        failedModel: "mock-1",
        agentDir: "/state/agents/work/agent",
      };
      input.suspendForFailure(suspension);
      input.suspendForFailure({ ...suspension, agentId: "explicit" });
      const agentId = boundParams.agentId;
      try {
        boundParams.agentId = undefined;
        input.suspendForFailure(suspension);
      } finally {
        boundParams.agentId = agentId;
      }
      return { meta: { durationMs: 1 } };
    });

    await runWithDeferredSessionSuspension(
      () => runEmbeddedAgent(params),
      (request) => requests.push(request),
    );

    expect(requests.map(({ agentId }) => agentId)).toEqual(["research", "explicit", undefined]);
    expect(requests[0]?.agentDir).toBe("/state/agents/work/agent");
    expect(requests[0]).not.toHaveProperty("laneId");
  });

  it("suspends the canonical agent selected during prepared-runtime acquisition", async () => {
    const { params, scope } = await createRun(undefined, "main");
    // Global keys have an explicit owner but no agent prefix to contradict a rebind.
    params.sessionKey = scope.sessionKey = "global";
    const researchScope = {
      agentId: "research",
      sessionKey: "global",
      storePath: resolveSessionStorePathCore(undefined, { agentId: "research" }),
    };
    for (const target of [scope, researchScope]) {
      await upsertSessionEntryCore(target, { sessionId: params.sessionId, updatedAt: 1 });
    }
    const acquire = vi.mocked(acquireRuntime).getMockImplementation();
    assert(acquire, "Expected the prepared-runtime fixture");
    vi.mocked(acquireRuntime).mockImplementationOnce(async (...args) => {
      const lease = await acquire(...args);
      return { ...lease, snapshot: { ...lease.snapshot, agentId: "research" } };
    });
    failAttempt("assistant", params.sessionId);

    await expect(runEmbeddedAgent(params)).rejects.toMatchObject({ reason: "billing" });
    await joinSuspensionWrites();
    expect(loadSessionEntry(scope)?.quotaSuspension).toBeUndefined();
    expect(loadSessionEntry(researchScope)?.quotaSuspension).toMatchObject({
      state: "suspended",
      reason: "manual",
    });
  });

  it.each(["detached", "durable"] as const)(
    "preserves %s persistence when the outer fallback exhausts after deferral",
    async (persistence) => {
      const { params, scope, database, seed } = await createRun(persistence);
      if (persistence === "durable") {
        await seed();
      }
      failAttempt("prompt", params.sessionId);
      const candidates: string[] = [];
      await expect(
        runWithModelFallback({
          cfg: params.config,
          provider: params.provider,
          model: params.model,
          agentId: params.agentId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          agentDir: params.agentDir,
          skipAuthProfileRuntime: true,
          run: async (provider, model) => {
            candidates.push(model);
            if (model === "mock-2") {
              // No second suspension: only the first candidate's deferred request can flush.
              throw new Error("fallback preparation failed");
            }
            return runEmbeddedAgent({ ...params, provider, model });
          },
        }),
      ).rejects.toThrow("fallback preparation failed");
      await joinSuspensionWrites();
      expect(candidates).toEqual(["mock-1", "mock-2"]);
      expect(runAttempt).toHaveBeenCalledOnce();
      if (persistence === "detached") {
        await expectAbsent(database);
      } else {
        expect(loadSessionEntry(scope)?.quotaSuspension).toMatchObject({
          state: "suspended",
          reason: "quota_exhausted",
          failedProvider: "openai",
          failedModel: "mock-1",
        });
      }
    },
  );

  it.each([
    { outcome: "success", existing: false },
    { outcome: "assistant", existing: false },
    { outcome: "aborted", existing: false },
    { outcome: "success", existing: true },
    { outcome: "assistant", existing: true },
  ] as const)(
    "keeps detached $outcome metadata unchanged (existing row: $existing)",
    async ({ outcome, existing }) => {
      const { params, scope, seed, run, expectNoAgent } = await createRun("detached");
      if (existing) {
        await seed(pendingSwitch());
      }
      const before = loadSessionEntry(scope);
      if (outcome === "assistant") {
        failAttempt(outcome, params.sessionId);
      } else {
        runAttempt.mockResolvedValue({
          ...successfulAttempt(params.sessionId),
          terminal:
            outcome === "aborted" ? { kind: "aborted", source: "external" } : { kind: "ok" },
        });
      }
      const pending = run(existing ? {} : { sessionKey: undefined });
      if (outcome === "assistant") {
        await expect(pending).rejects.toMatchObject(billingFailure);
      } else {
        const result = await pending;
        expect(result.meta.agentMeta?.sessionId).toBe(params.sessionId);
        if (existing) {
          expect(result).toMatchObject(verified);
        }
      }
      await joinSuspensionWrites();
      expect(runAttempt).toHaveBeenCalledOnce();
      if (existing) {
        expect(loadSessionEntry(scope)).toEqual(before);
      } else {
        await expectNoAgent();
      }
    },
  );

  it("still applies and eagerly clears live switches for durable turns", async () => {
    const { params, scope, seed, run } = await createRun("durable");
    await seed(pendingSwitch());
    failAttempt("prompt", params.sessionId);
    await expect(run()).rejects.toMatchObject({
      name: "LiveSessionModelSwitchError",
      provider: "openai",
      model: "mock-2",
    });
    expect(loadSessionEntry(scope)?.liveModelSwitchPending).toBeUndefined();
    await upsertSessionEntryCore(scope, {
      ...loadSessionEntry(scope)!,
      liveModelSwitchPending: true,
    });
    await expect(run({ model: "mock-2" })).rejects.toMatchObject({
      reason: "rate_limit",
      suspend: true,
    });
    await joinSuspensionWrites();
    expect(loadSessionEntry(scope)?.liveModelSwitchPending).toBeUndefined();
  });

  it.each([false, true])(
    "reads bootstrap state from the detached manager (has messages: %s)",
    async (hasMessages) => {
      const { params, run, expectNoAgent } = await createRun("detached");
      const { resolveExistingAttemptTranscriptState } =
        await import("./run/attempt-transcript-helpers.js");
      if (hasMessages) {
        params.sessionManager.appendMessage(makeUserMessage("in-memory history", 1));
      }
      runAttempt.mockImplementationOnce(async (attempt) => {
        expect(
          await resolveExistingAttemptTranscriptState({ ...attempt, agentId: "research" }),
        ).toEqual({ hasBootstrapTranscriptState: hasMessages });
        return successfulAttempt(params.sessionId);
      });
      await expect(run()).resolves.toMatchObject(verified);
      await expectNoAgent();
    },
  );

  it.each([
    ["overflow", false, "active"],
    ["timeout", true, "active"],
    ["timeout", false, "replaced"],
  ] as const)(
    "compacts the caller's buffer for outer %s recovery without durable access (existing row: %s, owner: %s)",
    async (trigger, existing, owner) => {
      const { params, scope, database, seed, expectNoAgent, run } = await createRun("detached");
      params.config.agents!.defaults!.compaction = { mode: "default", keepRecentTokens: 1 };
      setRuntimeConfigSnapshot(params.config);
      const manager = params.sessionManager;
      manager.appendMessage(makeUserMessage("Remember the memory-only project.", 1));
      manager.appendMessage(assistant("The project is called Blue Heron."));
      manager.appendMessage(makeUserMessage("What is the project called?", 3));
      if (existing) {
        await seed(pendingSwitch("mock-1"));
        SessionManager.open({ ...scope, sessionId: params.sessionId }).appendMessage(
          makeUserMessage("BORROWED DURABLE HISTORY MUST NOT BE READ", 1),
        );
      }
      const before = loadSessionEntry(scope);
      await closeAgentDatabases();
      const databaseBefore = existing ? await fs.readFile(database) : undefined;
      const open = vi.spyOn(SessionManager, "open");
      const targetResolver =
        await import("../../config/sessions/session-accessor.transcript-target.js");
      const resolveTarget = vi.spyOn(targetResolver, "resolveSessionTranscriptRuntimeTarget");
      let replacement: import("../admitted-run-context.js").PreparedAgentRunAdmission | undefined;
      let historyAtSummary: ReturnType<SessionManager["getEntries"]> | undefined;
      summaryStream.mockImplementation(async (_model, context: Context) => {
        const prompt = JSON.stringify(context.messages);
        expect(prompt).toContain("Blue Heron");
        expect(prompt).not.toContain("BORROWED DURABLE HISTORY");
        historyAtSummary = structuredClone(manager.getEntries());
        if (owner === "replaced") {
          const { prepareSystemAgentRunAdmission } = await import("../admitted-run-context.js");
          replacement = prepareSystemAgentRunAdmission(
            params.config,
            params.runId,
            "research",
            "replacement",
          );
          await replacement.admit("embedded");
        }
        const stream = createAssistantMessageEventStream();
        const message = assistant("The memory-only project is Blue Heron.");
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
        return stream;
      });
      const registry = await import("../../context-engine/registry.js");
      const { delegateCompactionToRuntime } = await import("../../context-engine/delegate.js");
      const engines = await registry.resolveLogicalTurnContextEngines(params.config);
      const compact = vi.fn(delegateCompactionToRuntime);
      engines.configured.engine.compact = compact;
      vi.mocked(registry.resolveLogicalTurnContextEngines).mockResolvedValueOnce(engines);
      runAttempt
        .mockImplementationOnce(async () => {
          // Recovery starts after the real run owner has prepared portable identity.
          resolveTarget.mockClear();
          return makeEmbeddedRunnerAttempt({
            sessionIdUsed: params.sessionId,
            terminal:
              trigger === "overflow"
                ? { kind: "failed", source: "prompt", error: new Error("context overflow") }
                : { kind: "timeout", phase: "prompt", source: "runtime" },
            attemptUsage: { input: 150_000, total: 150_000 },
            lastAssistant: buildEmbeddedRunnerAssistant({ usage: createMockUsage(150_000, 0) }),
          });
        })
        .mockImplementationOnce(async (attempt) => {
          expect(attempt.sessionManager).toBe(manager);
          expect(manager.getEntries()).toContainEqual(
            expect.objectContaining({
              type: "compaction",
              summary: expect.stringContaining("The memory-only project is Blue Heron."),
            }),
          );
          expect(JSON.stringify(manager.buildSessionContext().messages)).toContain("Blue Heron");
          expect(manager.buildSessionContext().messages).toContainEqual(
            expect.objectContaining({ role: "user", content: "What is the project called?" }),
          );
          return successfulAttempt(params.sessionId, "Blue Heron.");
        });
      try {
        const pending = run();
        if (owner === "replaced") {
          await expect(pending).rejects.toBeInstanceOf(Error);
          expect(manager.getEntries()).toEqual(historyAtSummary);
        } else {
          await expect(pending).resolves.toMatchObject({ payloads: [{ text: "Blue Heron." }] });
          const compaction = await compact.mock.results[0]?.value;
          expect(compaction, compaction?.reason).toMatchObject({ ok: true, compacted: true });
        }
      } finally {
        replacement?.close();
      }
      expect(compact).toHaveBeenCalledOnce();
      expect(summaryStream).toHaveBeenCalledOnce();
      expect(runAttempt).toHaveBeenCalledTimes(owner === "replaced" ? 1 : 2);
      expect(open).not.toHaveBeenCalled();
      expect(resolveTarget).not.toHaveBeenCalled();
      expect.soft(loadSessionEntry(scope)).toEqual(before);
      await closeAgentDatabases();
      if (existing) {
        expect(await fs.readFile(database)).toEqual(databaseBefore);
      } else {
        await expectNoAgent();
      }
    },
  );

  it("retries unsupported thinking without creating durable session state", async () => {
    const { params, run, expectNoAgent } = await createRun("detached");
    runAttempt
      .mockResolvedValueOnce(
        makeEmbeddedRunnerAttempt({
          sessionIdUsed: params.sessionId,
          terminal: {
            kind: "failed",
            source: "prompt",
            error: new Error("thinking level not supported; supported values: minimal"),
          },
        }),
      )
      .mockResolvedValueOnce(successfulAttempt(params.sessionId));
    await expect(run({ sessionManager: undefined })).resolves.toMatchObject(verified);
    expect(runAttempt).toHaveBeenCalledTimes(2);
    await expectNoAgent();
  });

  it.each([
    ["openclaw", true],
    ["openclaw", false],
    ["codex", true],
    ["codex", false],
  ] as const)(
    "does not persist detached %s trajectory metadata (caller manager: %s)",
    async (harness, suppliedManager) => {
      const { params, run, expectNoAgent } = await createRun("detached");
      const { prepareEmbeddedAttemptTrajectory } = await import("./run/attempt-trajectory.js");
      runAttempt.mockImplementationOnce(async (attempt) => {
        const recorder = await prepareEmbeddedAttemptTrajectory({
          activeSession: { sessionId: attempt.sessionId },
          attempt,
          clientToolCount: 0,
          effectiveToolCount: 0,
          effectiveWorkspace: params.workspaceDir,
          localModelLeanEnabled: false,
          sessionAgentId: "research",
        });
        await recorder?.flush();
        return successfulAttempt(params.sessionId);
      });
      await expect(
        run({
          agentHarnessRuntimeOverride: harness,
          sessionManager: suppliedManager ? params.sessionManager : undefined,
        }),
      ).resolves.toMatchObject(verified);
      await expectNoAgent();
    },
  );

  it("does not spend the candidate deferral on a detached run before durable runs", async () => {
    const { params, scope, database, seed, run } = await createRun("detached");
    const deferred: SessionSuspensionParams[] = [];
    failAttempt("prompt", params.sessionId);
    await runWithDeferredSessionSuspension(
      async () => {
        await expect(run()).rejects.toMatchObject({ reason: "rate_limit" });
        await joinSuspensionWrites();
        expect.soft(deferred).toEqual([]);
        await expectAbsent(database);

        await seed();
        await expect(run({ sessionPersistence: "durable" })).rejects.toMatchObject({
          reason: "rate_limit",
        });
        await joinSuspensionWrites();
        expect.soft(loadSessionEntry(scope)?.quotaSuspension).toBeUndefined();
        expect.soft(deferred).toMatchObject([{ sessionId: params.sessionId, agentId: "research" }]);

        // Only one durable run inherits deferral; subsequent direct work still suspends.
        await expect(
          run({ sessionPersistence: "durable", runId: "later-direct-run" }),
        ).rejects.toMatchObject({ reason: "rate_limit" });
        await joinSuspensionWrites();
        expect(loadSessionEntry(scope)?.quotaSuspension?.state).toBe("suspended");
        expect(deferred).toHaveLength(1);
      },
      (request) => deferred.push(request),
    );
  });
});

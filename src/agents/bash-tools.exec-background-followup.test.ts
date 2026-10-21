import "../test-utils/prepare-compiled-subprocesses.js";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import * as sessionEvents from "../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  loadSessionEntry,
  readSessionTranscriptMessageEvents,
  replaceSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import * as sessionReads from "../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { removeCronRunContinuationSessionIfIdle } from "../cron/run-continuation-cleanup.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../infra/agent-run-registry.js";
import { resetSystemEventsForTest } from "../infra/system-events.js";
import { createTestPluginApi } from "../plugin-sdk/plugin-test-api.js";
import type { OpenClawPluginDefinition } from "../plugins/plugin-definition.types.js";
import type { OpenClawPluginToolFactory } from "../plugins/tool-types.js";
import { withSessionTurn } from "../sessions/session-controller.admission.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import {
  createAdmittedRunOperatorAuthority,
  readAdmittedRunOperatorAuthority,
} from "./admitted-run-context.js";
import { waitForExecScope } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import type { ExecToolDefaults } from "./bash-tools.exec-types.js";
import {
  admitModelTurn,
  completionConfig,
  expectCompleted,
  fullGatewayExec,
  nodeCommand,
  runningSession,
} from "./bash-tools.lifecycle.test-support.js";
import { createProcessTool } from "./bash-tools.process.js";
import type { RunEmbeddedAgentParams } from "./embedded-agent-runner/run/params.js";
import { runEmbeddedAgent } from "./embedded-agent.js";
import {
  preparePluginToolExecutionCapabilities,
  type PluginToolExecutionCapabilities,
} from "./plugin-tool-execution.js";
import { withGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";

// mock-isolation: Keep model inference outside the real process and session-event ownership fixture.
vi.mock("./embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));
const model = vi.mocked(runEmbeddedAgent);
await Promise.all([
  import("../auto-reply/dispatch.js"),
  import("../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);

let reviewFactory: OpenClawPluginToolFactory<2>;
let state: OpenClawTestState;
let config: OpenClawConfig;
const receipts: sessionEvents.SessionEventReceipt[] = [];
const enqueue = sessionEvents.enqueueSessionEventForHost;

beforeAll(async () => {
  const { default: autoreview } = await loadBundledPluginFacade<{
    default: OpenClawPluginDefinition;
  }>({ pluginId: "autoreview", artifactBasename: "index.js" });
  autoreview.register!(
    createTestPluginApi({
      registerTool(tool) {
        if (typeof tool === "object" && "contextVersion" in tool) {
          reviewFactory = tool;
        }
      },
    }),
  );
  state = await createOpenClawTestState({
    label: "exec-followup",
    env: { OPENCLAW_TEST_FAST: "0" },
  });
  config = completionConfig(state.workspaceDir);
  const models = expectDefined(config.agents?.defaults?.models, "completion fixture models");
  models["mock-openai/admin-only"] = { agentRuntime: { id: "openclaw" } };
  await state.writeConfig(config);
  openOpenClawStateDatabase();
});

beforeEach(() => {
  setRuntimeConfigSnapshot(config);
  model.mockReset().mockImplementation(async (params: RunEmbeddedAgentParams) => {
    await admitModelTurn(params);
    return { payloads: [{ text: "NO_REPLY" }], meta: { durationMs: 1 } };
  });
  vi.spyOn(sessionEvents, "enqueueSessionEventForHost").mockImplementation((text, options) => {
    const receipt = enqueue(text, options);
    receipts.push(receipt);
    return receipt;
  });
});

afterEach(async () => {
  for (const receipt of receipts) {
    receipt.cancel();
  }
  await Promise.all(receipts.map((receipt) => receipt.settled));
  receipts.length = 0;
  vi.restoreAllMocks();
  resetProcessRegistryForTests();
  resetSystemEventsForTest();
});

afterAll(() => state?.cleanup());

async function seedOrigin(sessionKey: string, spawnedBy?: string) {
  await replaceSessionEntry(
    { agentId: "main", sessionKey },
    {
      sessionId: sessionKey.replaceAll(":", "-"),
      lifecycleRevision: "original",
      updatedAt: Date.now(),
      sessionStartedAt: Date.now(),
      permissionMode: "full",
      ...(spawnedBy ? { spawnedBy, spawnDepth: 1 } : {}),
    },
  );
}

async function completion(signal: AbortSignal) {
  const receipt = expectDefined(receipts.at(-1), "ordinary completion receipt");
  expect(await withinTest(receipt.accepted, signal)).toEqual({ ok: true });
  const outcome = await withinTest(receipt.settled, signal);
  expect(outcome, outcome.error).toMatchObject({
    status: "completed",
    executionStarted: true,
  });
}

function backgroundExec(sessionKey: string, overrides: ExecToolDefaults = {}) {
  const tool = createExecTool({
    config,
    ...fullGatewayExec,
    sessionKey,
    scopeKey: sessionKey,
    notifyOnExit: true,
    allowBackground: true,
    ...overrides,
  });
  return (callId: string, script: string) =>
    tool.execute(callId, {
      command: nodeCommand(script),
      background: true,
    });
}

test.each([
  { label: "explicit background", args: { background: true } },
  { label: "elapsed yield window", args: { yieldMs: 10 } },
  { label: "disabled timeout", args: { background: true, timeoutSeconds: 0 } },
])("provides a usable structured follow-up route after $label", async ({ label, args }) => {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(state.workspaceDir, "exec-followup-")),
  );
  const releasePath = path.join(directory, "release");
  const scopeKey = `agent:main:followup-${label}`;
  const exec = createExecTool({
    config,
    ...fullGatewayExec,
    allowBackground: true,
    notifyOnExit: false,
    timeoutSec: 5,
    scopeKey,
  });
  const processTool = createProcessTool({ scopeKey });
  // A parent-owned file releases the child only after the background result is observed.
  const command = nodeCommand(
    `const fs = require("node:fs"); const release = ${JSON.stringify(releasePath)};
     const finish = () => { if (fs.existsSync(release)) { watcher.close(); process.stdout.write("FOLLOWUP_COMPLETE"); } };
     const watcher = fs.watch(${JSON.stringify(directory)}, finish); finish();`,
  );
  try {
    const requestedAt = Date.now();
    const started = await exec.execute("followup-start", { command, ...args });
    expect(started.details.status).toBe("running");
    if (started.details.status !== "running") {
      throw new Error("Expected a background process handle");
    }
    const deadlineAtMs = started.details.deadlineAtMs;
    if (args.timeoutSeconds === 0) {
      expect(deadlineAtMs).toBeUndefined();
      expect(started.details.followUp).not.toContain("Automatic stop will be requested");
    } else {
      if (deadlineAtMs === undefined) {
        throw new Error("Expected the actual process timeout deadline");
      }
      expect(deadlineAtMs).toBeGreaterThanOrEqual(requestedAt + 4_999);
      expect(deadlineAtMs).toBeLessThanOrEqual(Date.now() + 5_001);
      expect(started.content).toContainEqual({
        type: "text",
        text: expect.stringContaining(new Date(deadlineAtMs).toISOString()),
      });
    }
    expect(started.details).toMatchObject({ followUp: expect.stringContaining("Use process") });
    const followUp = started.details.followUp;
    expect(followUp).toContain("poll");
    if (!followUp) {
      throw new Error("Expected a structured follow-up route");
    }
    expect(started.content).toContainEqual({
      type: "text",
      text: expect.stringContaining(followUp),
    });

    await fs.writeFile(releasePath, "release");
    await waitForExecScope(scopeKey);
    const completed = await processTool.execute("followup-poll", {
      action: "poll",
      sessionId: started.details.sessionId,
    });
    expect(completed.details).toMatchObject({
      status: "completed",
      sessionId: started.details.sessionId,
      aggregated: "FOLLOWUP_COMPLETE",
    });
  } finally {
    await fs.writeFile(releasePath, "release");
    await waitForExecScope(scopeKey);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("does not advertise detached continuation when process is unavailable", async () => {
  const exec = createExecTool({
    ...fullGatewayExec,
    processToolAvailabilityRef: { value: false },
    notifyOnExit: false,
  });
  const result = await exec.execute("followup-foreground", {
    command: nodeCommand('process.stdout.write("FOREGROUND_COMPLETE")'),
    background: true,
  });
  expect(result.details).toMatchObject({ status: "completed", aggregated: "FOREGROUND_COMPLETE" });
  expect(result.details).not.toHaveProperty("followUp");
});

test.for(["ordinary", "live cron", "queued cron", "ended cron", "cron ended during admission"])(
  "keeps exec completion bound to its origin: %s",
  async (scenario, { signal }) => {
    const cron = scenario !== "ordinary";
    const sessionKey = cron
      ? `agent:main:cron:nightly:run:${scenario.replaceAll(" ", "-")}`
      : "agent:main:main";
    const sessionId = sessionKey.replaceAll(":", "-");
    const exact = { agentId: "main", sessionKey };
    const base = { agentId: "main", sessionKey: "agent:main:cron:nightly" };
    const removed = createDeferredCore();
    let unsubscribe = () => {};
    if (scenario === "queued cron") {
      // Cron persists the base before the exact run claims the shared transcript window.
      await replaceSessionEntry(base, { sessionId, updatedAt: Date.now() });
      unsubscribe = sessionChanges.subscribeFacts((change) => {
        if (
          "sessionKey" in change &&
          change.sessionKey === sessionKey &&
          change.facts?.kind === "removed"
        ) {
          removed.resolve();
        }
      });
    }
    await seedOrigin(sessionKey);
    const claim = claimAgentRunContext(
      "cron-run-followup",
      { sessionKey, sessionId, agentId: "main" },
      { trackOwner: true },
    );
    const release = () => releaseAgentRunContext("cron-run-followup", claim);
    vi.spyOn(sessionEvents, "enqueueSessionEventForHost").mockImplementation((text, options) => {
      expect(options.sessionKey).toBe(sessionKey);
      if (scenario === "ended cron") {
        release();
      }
      const receipt = enqueue(text, options);
      receipts.push(receipt);
      if (scenario === "cron ended during admission") {
        release();
      }
      return receipt;
    });
    const exec = backgroundExec(sessionKey, { agentId: "main" });
    try {
      const start = async () => {
        const started = await exec("cron-followup", 'process.stdout.write("CRON_EXEC_DONE")');
        const { sessionId: processSessionId } = runningSession(started.details);
        await withinTest(waitForExecScope(sessionKey), signal);
        if (scenario === "queued cron") {
          const receipt = expectDefined(receipts[0], "queued cron completion receipt");
          expect(await withinTest(receipt.accepted, signal)).toEqual({ ok: true });
          expect(model).not.toHaveBeenCalled();
          expect(
            readSessionTranscriptMessageEvents({ agentId: "main", sessionKey, sessionId }),
          ).toEqual([]);
          // Successful cron teardown seals the alias after persisting its stable base.
          await upsertSessionEntryCore(exact, {
            cronRunContinuation: {
              lifecycleRevision: "original",
              phase: "ready",
              basePersisted: true,
            },
          });
          await removeCronRunContinuationSessionIfIdle(sessionKey);
          expect(loadSessionEntry(exact)?.sessionId).toBe(sessionId);
          release();
        }
        return processSessionId;
      };
      // Cron preparation and embedded execution share this controller admission.
      const processSessionId =
        scenario === "queued cron"
          ? await withSessionTurn(
              {
                sessionKey,
                sessionId,
                agentId: "main",
                storePath: resolveSessionStorePathCore(config.session?.store, { agentId: "main" }),
              },
              start,
            )
          : await start();
      if (scenario.includes("ended")) {
        if (scenario === "cron ended during admission") {
          expect(receipts).toHaveLength(1);
          const receipt = expectDefined(receipts[0], "cron completion receipt");
          expect(await withinTest(receipt.settled, signal)).toMatchObject({
            status: "failed",
            executionStarted: false,
            error: expect.stringContaining("Originating cron run ended"),
          });
        } else {
          expect(receipts).toHaveLength(0);
        }
        expect(model).not.toHaveBeenCalled();
      } else {
        await completion(signal);
        expect(receipts).toHaveLength(1);
        expect(model).toHaveBeenCalledOnce();
        const [params] = expectDefined(model.mock.calls[0], "completion turn");
        expect(params.sessionKey).toBe(sessionKey);
        if (scenario === "queued cron") {
          await withinTest(removed.promise, signal);
          expect(loadSessionEntry(exact)).toBeUndefined();
          expect(loadSessionEntry(base)?.sessionId).toBe(sessionId);
          expect(readSessionTranscriptMessageEvents({ ...base, sessionId })).toMatchObject([
            { event: { type: "message", message: { role: "user" } } },
          ]);
          expect(params.prompt).toContain("CRON_EXEC_DONE");
        }
      }
      const result = await createProcessTool({ scopeKey: sessionKey }).execute("collect", {
        action: "log",
        sessionId: processSessionId,
      });
      expect(result.content).toContainEqual({ type: "text", text: "CRON_EXEC_DONE" });
    } finally {
      unsubscribe();
      release();
    }
  },
);

test("starts and notifies when identity enrichment fails, then resolves child identity again", async ({
  signal,
}) => {
  const sessionKey = "agent:main:dashboard:notification-possible";
  await seedOrigin(sessionKey);
  vi.spyOn(sessionReads, "readSessionEntriesFromStoreInWorker").mockRejectedValueOnce(
    new Error("session worker unavailable"),
  );
  const exec = backgroundExec(sessionKey);
  const processTool = createProcessTool({ scopeKey: sessionKey });
  for (const recovered of [false, true]) {
    if (recovered) {
      await seedOrigin(sessionKey, "agent:main:main");
    }
    const started = await exec(
      "notification-possible",
      'process.stdout.write("EXEC_STARTED"); process.exitCode = 1',
    );
    const { sessionId } = runningSession(started.details);
    await withinTest(waitForExecScope(sessionKey), signal);
    if (!recovered) {
      await completion(signal);
    }
    expect(receipts).toHaveLength(1);
    expect(model).toHaveBeenCalledOnce();
    const result = await processTool.execute("collect", {
      action: "poll",
      sessionId,
    });
    expectCompleted(result.details, "EXEC_STARTED", 1);
  }
});

test("reports manual collection after destination capture fails, then recovers on the same tool", async ({
  signal,
}) => {
  const sessionKey = "agent:main:exec-capture-failure";
  await seedOrigin(sessionKey);
  // Force a cold destination read so the transport fault cannot be bypassed by writer receipts.
  sessionChanges.invalidate({
    agentId: "main",
    sessionKey,
    storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
    factsInvalidated: true,
  });
  let faults = 0;
  const capture = sessionEvents.captureSessionEventTargetForHost;
  vi.spyOn(sessionEvents, "captureSessionEventTargetForHost").mockImplementation(
    async (...args) => {
      if (args[0] === "main" && args[1] === sessionKey && faults === 0) {
        faults++;
        throw new Error("session event destination unavailable");
      }
      return capture(...args);
    },
  );
  const exec = backgroundExec(sessionKey, { agentId: "main", notifyOnExitEmptySuccess: true });
  const processTool = createProcessTool({ scopeKey: sessionKey });
  for (const recovered of [false, true]) {
    const release = path.join(state.workspaceDir, `release-${recovered}`);
    const child = `const fs = require("node:fs"); const release = ${JSON.stringify(release)}; const watcher = fs.watch(${JSON.stringify(state.workspaceDir)}, () => { if (fs.existsSync(release)) { watcher.close(); process.stdout.write("EXEC_COLLECTED"); } }); if (fs.existsSync(release)) { watcher.close(); process.stdout.write("EXEC_COLLECTED"); }`;
    try {
      const started = await exec("capture-failure", child);
      expect(faults).toBe(1);
      const handle = runningSession(started.details);
      const followUp = expectDefined(handle.followUp, "background continuation guidance");
      expect(followUp).toContain(
        recovered ? "wake this conversation automatically" : "poll with a timeout",
      );
      if (!recovered) {
        expect(followUp).not.toContain("wake this conversation automatically");
      }
      expect(started.content).toContainEqual({
        type: "text",
        text: expect.stringContaining(followUp),
      });
      for (const action of ["list", "poll", "log"] as const) {
        const running = await processTool.execute("inspect", {
          action,
          sessionId: handle.sessionId,
        });
        if (!recovered) {
          const expected = {
            sessionId: handle.sessionId,
            followUp: expect.stringContaining("before ending the turn"),
          };
          expect(running.details).toMatchObject(
            action === "list" ? { sessions: [expected] } : expected,
          );
        }
      }
      await fs.writeFile(release, "release");
      await withinTest(waitForExecScope(sessionKey), signal);
      if (recovered) {
        await completion(signal);
      }
      expect(receipts).toHaveLength(recovered ? 1 : 0);
      expect(model).toHaveBeenCalledTimes(recovered ? 1 : 0);
      const collected = await processTool.execute("collect", {
        action: "poll",
        sessionId: handle.sessionId,
      });
      expectCompleted(collected.details, "EXEC_COLLECTED");
    } finally {
      await fs.writeFile(release, "release");
      await withinTest(waitForExecScope(sessionKey), signal);
    }
  }
});

test.for(["completed", "revoked", "missing"] as const)(
  "keeps the original guest review authority through exec completion: %s",
  async (scenario, { signal }) => {
    const sessionKey = `agent:main:guest-review-${scenario}`;
    await seedOrigin(sessionKey);
    const revoked = new AbortController();
    let references = 1;
    const authority = createAdmittedRunOperatorAuthority({
      profileId: "original-guest",
      scopes: ["operator.write"],
      signal: revoked.signal,
      assertCurrent() {
        if (!references) {
          throw new Error("original source released");
        }
      },
      retain() {
        references++;
        return () => {
          references--;
        };
      },
      modelPolicy: {
        models: [{ provider: "mock-openai", model: "gpt-5.6-luna" }],
        allows: (ref) => ref.provider === "mock-openai" && ref.model === "gpt-5.6-luna",
      },
    });
    const admin = createAdmittedRunOperatorAuthority({
      profileId: "another-admin",
      scopes: ["operator.admin"],
      assertCurrent() {},
    });
    const adminExecution = expectDefined(
      preparePluginToolExecutionCapabilities({ authority: admin, config, agentId: "main" })(
        () => {},
      ).modelExecution,
      "admin reviewer capability",
    );
    await expect(
      adminExecution.run(
        { model: "mock-openai/admin-only", explicit: true },
        async ({ model: selectedModel }) => selectedModel,
      ),
    ).resolves.toBe("mock-openai/admin-only");
    const enqueueFromAdmin = await withGatewayToolCallerIdentity(
      { agentId: "main", sessionKey, operatorAuthority: admin },
      () =>
        AsyncLocalStorage.bind((...args: Parameters<typeof enqueue>) => {
          const receipt = enqueue(...args);
          receipts.push(receipt);
          return receipt;
        }),
    );
    vi.mocked(sessionEvents.enqueueSessionEventForHost).mockImplementation(enqueueFromAdmin);
    const constructReview = (capabilities: PluginToolExecutionCapabilities) =>
      reviewFactory.create({
        ...capabilities,
        // External sandbox and installed-skill facts stay fixed while the admitted source changes.
        sandbox: {
          workspaceDir: "/workspace",
          installedSkillRoots: { autoreview: "/protected/autoreview" },
          run: vi.fn(),
        },
        assertInvocationCurrent() {},
      });
    const original = scenario === "missing" ? undefined : authority;
    const initial = preparePluginToolExecutionCapabilities({
      authority: original,
      config,
      agentId: "main",
    })(() => {});
    expect(Boolean(constructReview(initial))).toBe(scenario !== "missing");
    const reached = createDeferredCore<PluginToolExecutionCapabilities>();
    const proceed = createDeferredCore();
    model.mockImplementation(async (params) => {
      const admitted = await expectDefined(params.preparedRunAdmission, "event admission").admit(
        "gateway",
        params.runId,
      );
      await params.userTurnTranscriptRecorder?.persistApproved();
      params.onExecutionPhase?.({ phase: "model_call_started" });
      await params.onExecutionStarted?.();
      await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
      const current = readAdmittedRunOperatorAuthority(admitted);
      reached.resolve(
        preparePluginToolExecutionCapabilities({
          authority: current,
          config: params.config,
          agentId: "main",
        })(() => {}),
      );
      await proceed.promise;
      expect(current?.profileId).toBe(original?.profileId);
      expect(params.senderIsOwner).not.toBe(true);
      return { payloads: [{ text: "NO_REPLY" }], meta: { durationMs: 1 } };
    });
    try {
      const started = await withGatewayToolCallerIdentity(
        { agentId: "main", sessionKey, operatorAuthority: original },
        () =>
          backgroundExec(sessionKey, { agentId: "main" })(
            "guest-command",
            'process.stdout.write("GUEST_COMMAND_DONE")',
          ),
      );
      runningSession(started.details);
      references--;
      await withinTest(waitForExecScope(sessionKey), signal);
      const continued = await withinTest(reached.promise, signal);
      expect(Boolean(constructReview(continued)), "background completion keeps AutoReview").toBe(
        scenario !== "missing",
      );
      if (scenario !== "missing") {
        const execute = expectDefined(continued.modelExecution, "guest reviewer capability");
        const action = vi.fn(async ({ model: selectedModel }: { model: string }) => selectedModel);
        await expect(execute.run({ model: null, explicit: false }, action)).resolves.toBe(
          "mock-openai/gpt-5.6-luna",
        );
        await expect(
          execute.run({ model: "mock-openai/admin-only", explicit: true }, action),
        ).rejects.toThrow();
        expect(action).toHaveBeenCalledOnce();
        if (scenario === "revoked") {
          revoked.abort(new Error("original guest revoked"));
          await expect(execute.run({ model: null, explicit: false }, action)).rejects.toThrow(
            "original guest revoked",
          );
          expect(action).toHaveBeenCalledOnce();
        }
      }
      proceed.resolve();
      if (scenario === "revoked") {
        expect(
          await withinTest(expectDefined(receipts.at(-1), "revoked event").settled, signal),
        ).toMatchObject({ status: "cancelled" });
      } else {
        await completion(signal);
      }
      expect(references).toBe(0);
    } finally {
      proceed.resolve();
      await withinTest(waitForExecScope(sessionKey), signal);
    }
  },
);

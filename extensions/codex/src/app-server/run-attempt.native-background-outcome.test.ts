import path from "node:path";
import { initializeGlobalHookRunner, registerInternalHook } from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { readAttemptTerminal } from "./attempt-terminal.test-helper.js";
import { resolveCodexAppServerHomeDir } from "./auth-start-options.js";
import {
  isCodexAppServerLiveThreadProtected,
  retainCodexAppServerLiveThread,
} from "./client-runtime.js";
import { ownCodexInferenceClient } from "./inference-routing.js";
import { isJsonObject, type JsonObject } from "./protocol.js";
import { itemNotification } from "./protocol.test-helpers.js";
import {
  answerCompleted,
  readManagedInstructions,
  retainSourceAuthority,
  runningCommand,
} from "./run-attempt-continuity.test-support.js";
import { seedRunSessionOwnerForTest } from "./run-attempt-session-owners.test-support.js";
import {
  createParams,
  createStartedThreadHarness,
  createTestParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
} from "./run-attempt-test-harness.js";
import { isCodexTurnContextHandoff } from "./test-support.js";
import { writeNativeCatalogFixture } from "./thread-lifecycle.test-fixtures.js";

setupRunAttemptTestHooks();

const FIRST_CATALOG = "<available_skills><skill><name>weather</name></skill></available_skills>";
const SECOND_CATALOG =
  "<available_skills><skill><name>weather</name><description>edited</description></skill></available_skills>";

describe("Codex app-server skill catalog delivery", () => {
  it("refreshes managed catalogs on the thread and relays the edit through compaction", async () => {
    const sessionKey = "agent:main:dashboard:incognito-managed-skills";
    await seedRunSessionOwnerForTest("session-1", sessionKey);
    const received: string[] = [];
    const personalUser = "Synthetic selected personal preferences.";
    const personalPath = path.join(tempDir, "users", "alice", "USER.md");
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as { bootstrapFiles: unknown[] };
      context.bootstrapFiles.push({
        name: "USER.md",
        path: personalPath,
        content: personalUser,
        missing: false,
        personalUser: true,
      });
    });
    let turnStart: unknown;
    const harness = createStartedThreadHarness(async (method, request) => {
      if (method === "account/read") {
        return { account: { type: "apiKey" } };
      }
      if (method === "turn/start") {
        turnStart = request;
        received.push(readManagedInstructions(harness.client, request));
      }
      return undefined;
    });
    ownCodexInferenceClient(harness.client);
    for (const [index, catalog] of [
      FIRST_CATALOG,
      SECOND_CATALOG,
      undefined,
      SECOND_CATALOG,
    ].entries()) {
      const params = createParams(path.join(tempDir, "managed.jsonl"), tempDir, {
        sessionKey,
        runId: `managed-${index}`,
      });
      params.skillsSnapshot = { prompt: catalog ?? "", skills: [] };
      if (index === 2) {
        params.bootstrapContextMode = "lightweight";
        params.bootstrapContextRunKind = "cron";
      }
      if (index === 3) {
        // Allow the real before_compaction history worker to start.
        params.timeoutMs = 60_000;
      }
      const run = runCodexAppServerAttempt(params);
      await run.waitForTurnAccepted();
      if (index === 3) {
        // Native compaction rebuilds from the creation catalog; the relay still carries
        // the edit on the continuation request of this turn.
        await harness.notify(
          itemNotification("item/started", { type: "contextCompaction", id: "compact-1" }),
        );
        await harness.notify(
          itemNotification("item/completed", { type: "contextCompaction", id: "compact-1" }),
        );
        received.push(readManagedInstructions(harness.client, turnStart));
      }
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      const result = await run;
      if (index !== 2) {
        expect(received[index]?.split(personalUser)).toHaveLength(2);
        expect(result.systemPromptReport?.injectedWorkspaceFiles).toContainEqual(
          expect.objectContaining({ path: personalPath, injectedChars: personalUser.length }),
        );
      }
    }
    // The relay carries the current catalog only while the native one differs.
    expect(received[0]).not.toContain("available_skills");
    expect(received[2]).toContain("refreshable thread instructions are empty");
    for (const text of [received[1], received[2], received[3], received[4]]) {
      expect(text).not.toContain(FIRST_CATALOG);
    }
    for (const text of [received[1], received[3], received[4]]) {
      expect(text).toContain(SECOND_CATALOG);
    }
    expect(received[4]?.split(personalUser)).toHaveLength(2);
    expect(received[2]).not.toContain("available_skills");
    const nativeRequests = harness.requests.filter(
      ({ method, params }) =>
        ["thread/start", "thread/resume", "thread/inject_items"].includes(method) &&
        !isCodexTurnContextHandoff(params),
    );
    // Creation, two refreshes, then the edit again and its post-compaction restore.
    expect(nativeRequests.map(({ method }) => method)).toEqual([
      "thread/start",
      "thread/inject_items",
      "thread/inject_items",
      "thread/inject_items",
      "thread/inject_items",
    ]);
    const delivered = nativeRequests.map((request) => JSON.stringify(request));
    expect(delivered[0]).toContain(FIRST_CATALOG);
    expect(delivered[1]).toContain(SECOND_CATALOG);
    expect(delivered[2]).not.toContain("available_skills");
    expect(delivered[3]).toContain(SECOND_CATALOG);
    expect(delivered[4]).toContain(SECOND_CATALOG);
    expect(JSON.stringify(harness.requests)).not.toContain(personalUser);
  });

  it("re-delivers the catalog on the next turn when the post-compaction restore fails", async () => {
    const sessionKey = "agent:main:dashboard:incognito-skill-restore-failure";
    await seedRunSessionOwnerForTest("session-1", sessionKey);
    let failNextInject = false;
    const harness = createStartedThreadHarness(async (method, request) => {
      if (
        method === "thread/inject_items" &&
        !isCodexTurnContextHandoff(request) &&
        failNextInject
      ) {
        failNextInject = false;
        throw new Error("inject_items unavailable");
      }
      return undefined;
    });
    const sessionFile = path.join(tempDir, "incognito-restore-failure-session.jsonl");
    const workspaceDir = path.join(tempDir, "incognito-restore-failure-workspace");
    const injectCount = () =>
      harness.requests.filter(
        ({ method, params }) =>
          method === "thread/inject_items" && !isCodexTurnContextHandoff(params),
      ).length;
    const runTurn = async (runId: string, catalog: string, options: { compact?: boolean } = {}) => {
      const params = createParams(sessionFile, workspaceDir, { sessionKey, runId });
      // Allow the real before_compaction history worker to start.
      params.timeoutMs = 60_000;
      params.skillsSnapshot = { prompt: catalog, skills: [] };
      const run = runCodexAppServerAttempt(params);
      await run.waitForTurnAccepted();
      if (options.compact) {
        await harness.notify(
          itemNotification("item/started", { type: "contextCompaction", id: "compact-1" }),
        );
        await harness.notify(
          itemNotification("item/completed", { type: "contextCompaction", id: "compact-1" }),
        );
      }
      await harness.completeTurn({ threadId: "thread-1", turnId: "turn-1" });
      await run;
    };

    await runTurn("run-1", FIRST_CATALOG);
    await runTurn("run-2", SECOND_CATALOG);
    expect(injectCount()).toBe(1);

    // A failed restore leaves the thread on the creation-time catalog. Recording
    // the refresh as still delivered would strand it there for the whole session.
    failNextInject = true;
    await runTurn("run-3", SECOND_CATALOG, { compact: true });
    expect(injectCount()).toBe(2);

    await runTurn("run-4", SECOND_CATALOG);
    const injected = harness.requests.filter(
      ({ method, params }) =>
        method === "thread/inject_items" && !isCodexTurnContextHandoff(params),
    );
    expect(injected).toHaveLength(3);
    expect(JSON.stringify(injected[2]?.params)).toContain(SECOND_CATALOG);
  });
});

it("delivers fresh prompt-hook parent context on the same protected thread", async () => {
  const agentDir = path.join(tempDir, "wire-agent");
  const codexHome = resolveCodexAppServerHomeDir(agentDir);
  const rolloutPath = path.join(codexHome, "sessions", "hook-parent.jsonl");
  let nativeTools: unknown;
  const contexts = ["Synthetic first-turn recall", "Synthetic second-turn recall"];
  let context = contexts[0];
  let systemPrompt: string | undefined;
  initializeGlobalHookRunner(
    createMockPluginRegistry([
      {
        hookName: "before_prompt_build",
        handler: async () => ({
          systemPrompt,
          prependSystemContext: context,
          appendSystemContext: `${context} clock`,
        }),
      },
    ]),
  );
  const source = new AbortController();
  const received: string[] = [];
  const command = runningCommand("background-listener", "synthetic-callback-listener", "12345");
  const harness = createStartedThreadHarness(
    async (method, request) => {
      if (method === "account/read") {
        return { account: { type: "apiKey" } };
      }
      if (method === "thread/backgroundTerminals/list") {
        return { data: [{ itemId: command.id, processId: command.processId }], nextCursor: null };
      }
      if (method === "thread/start") {
        nativeTools = (request as { dynamicTools?: unknown }).dynamicTools;
        const result = threadStartResult();
        return { ...result, thread: { ...result.thread, path: rolloutPath } };
      }
      if (method === "turn/start") {
        await writeNativeCatalogFixture(rolloutPath, "thread-1", nativeTools);
        received.push(readManagedInstructions(harness.client, request));
      }
      return undefined;
    },
    { persistedThreads: [], codexHome },
  );
  ownCodexInferenceClient(harness.client);
  const unsubscribe = { method: "thread/unsubscribe", params: { threadId: "thread-1" } };
  const paramsFor = (runId: string, prompt?: string) =>
    Object.assign(createParams(path.join(tempDir, "session.jsonl"), tempDir, { runId, prompt }), {
      agentDir,
    });
  try {
    for (const [index, hookContext] of contexts.entries()) {
      context = hookContext;
      const params = paramsFor(
        `run-${index}`,
        index === 0 ? "Start a callback listener" : "Explain the callback setup",
      );
      params.skillsSnapshot = {
        prompt: "<available_skills><skill><name>synthetic-skill</name></skill></available_skills>",
        skills: [],
      };
      params.hostCapabilities = {
        ...params.hostCapabilities,
        retainSourceAuthority: retainSourceAuthority(source.signal),
      };
      const run = runCodexAppServerAttempt(params);
      await run.waitForTurnAccepted();
      if (index === 0) {
        await harness.notify(itemNotification("item/started", command));
      }
      await harness.notify(answerCompleted("Ready."));
      await run;
      expect(isCodexAppServerLiveThreadProtected(harness.client, "thread-1")).toBe(true);
      expect(harness.requests).not.toContainEqual(unsubscribe);
    }
    expect(received).toHaveLength(2);
    for (const [index, hookContext] of contexts.entries()) {
      expect(received[index]?.split(`${hookContext} clock`)).toHaveLength(2);
      expect(received[index]?.split(hookContext)).toHaveLength(3);
      expect(received[index]).not.toContain("<available_skills>");
      expect(received[index]).toMatch(
        /Native model-owned policy[\s\S]*OpenClaw plugin-injected system context\./,
      );
    }
    expect(received[1]).not.toContain("Synthetic first-turn recall");
    systemPrompt = "Changed persistent thread policy";
    await expect(runCodexAppServerAttempt(paramsFor("changed-policy"))).rejects.toMatchObject({
      name: "AgentHarnessPreflightError",
      message:
        "Codex thread thread-1 still has background work after waiting for cleanup; stop its running work and retry.",
    });
    expect(isCodexAppServerLiveThreadProtected(harness.client, "thread-1")).toBe(true);
    expect(harness.requests).not.toContainEqual(unsubscribe);
    expect(
      harness.requests
        .filter(({ method }) => ["thread/start", "thread/resume"].includes(method))
        .map(({ method }) => method),
    ).toEqual(["thread/start"]);
    expect(JSON.stringify(harness.requests)).not.toMatch(/Synthetic (first|second)-turn recall/);
    expect(harness.requests.filter(({ method }) => method === "turn/start")).toHaveLength(2);
  } finally {
    source.abort(new Error("fixture cleanup"));
    harness.close();
  }
});

it.each([
  ["managed relay", true],
  ["appServer.command", false],
] as const)(
  "refreshes edited skills on a protected thread, then cold-resumes once it ends (%s)",
  async (_route, relay) => {
    const agentDir = path.join(tempDir, "protected-skills-agent");
    const codexHome = resolveCodexAppServerHomeDir(agentDir);
    const rolloutPath = path.join(codexHome, "sessions", "protected-skills.jsonl");
    let nativeTools: unknown;
    const source = new AbortController();
    const command = runningCommand("background-listener", "synthetic-callback-listener", "12345");
    let listenerRunning = true;
    const harness = createStartedThreadHarness(
      async (method, request) => {
        if (method === "account/read") {
          return { account: { type: "apiKey" } };
        }
        if (method === "thread/backgroundTerminals/list") {
          const data = listenerRunning
            ? [{ itemId: command.id, processId: command.processId }]
            : [];
          return { data, nextCursor: null };
        }
        if (method === "thread/start" || method === "thread/resume") {
          nativeTools ??= isJsonObject(request) ? request.dynamicTools : undefined;
          const result = threadStartResult();
          return { ...result, thread: { ...result.thread, path: rolloutPath } };
        }
        if (method === "turn/start") {
          await writeNativeCatalogFixture(rolloutPath, "thread-1", nativeTools);
        }
        return undefined;
      },
      { persistedThreads: [], codexHome },
    );
    if (relay) {
      ownCodexInferenceClient(harness.client);
    }
    try {
      for (const [index, catalog] of [FIRST_CATALOG, SECOND_CATALOG, SECOND_CATALOG].entries()) {
        if (index === 2) {
          // The listener ends: the first unprotected turn must make the edit native.
          listenerRunning = false;
          await harness.notify(
            itemNotification("item/completed", { ...command, status: "completed", exitCode: 0 }),
          );
          expect(isCodexAppServerLiveThreadProtected(harness.client, "thread-1")).toBe(false);
        }
        const params = Object.assign(
          createParams(path.join(tempDir, "protected-skills.jsonl"), tempDir, {
            runId: `run-${index}`,
          }),
          { agentDir },
        );
        params.skillsSnapshot = { prompt: catalog, skills: [] };
        params.hostCapabilities = {
          ...params.hostCapabilities,
          retainSourceAuthority: retainSourceAuthority(source.signal),
        };
        const run = runCodexAppServerAttempt(params);
        // A refused cold resume rejects the run before any turn is accepted.
        await Promise.race([run.waitForTurnAccepted(), run]);
        if (index === 0) {
          await harness.notify(itemNotification("item/started", command));
        }
        await harness.notify(answerCompleted("Ready."));
        expect(readAttemptTerminal(await run).promptError).toBeNull();
        expect(isCodexAppServerLiveThreadProtected(harness.client, "thread-1")).toBe(index < 2);
      }
      const threadRequests = harness.requests.filter(
        ({ method, params }) =>
          ["thread/start", "thread/resume", "thread/unsubscribe", "thread/inject_items"].includes(
            method,
          ) && !isCodexTurnContextHandoff(params),
      );
      expect(threadRequests.map(({ method }) => method)).toEqual([
        "thread/start",
        "thread/inject_items",
        // Cold resume makes the edited catalog native, then hands the current policy over.
        "thread/unsubscribe",
        "thread/resume",
        "thread/inject_items",
      ]);
      expect(JSON.stringify(threadRequests[0])).toContain(FIRST_CATALOG);
      expect(JSON.stringify(threadRequests[1])).toContain(SECOND_CATALOG);
      for (const request of threadRequests.slice(3)) {
        expect(JSON.stringify(request)).toContain(SECOND_CATALOG);
        expect(JSON.stringify(request)).not.toContain(FIRST_CATALOG);
      }
      expect(harness.requests.filter(({ method }) => method === "turn/start")).toHaveLength(3);
    } finally {
      source.abort(new Error("fixture cleanup"));
      harness.close();
    }
  },
);

it.each([
  ["retained", "52627"],
  ["foreign item", "52627"],
  ["foreign process", "52627"],
  ["completion during inventory", "52627"],
  ["revoked during inventory", "52627"],
  ["inventory unavailable", "52627"],
  ["retained", null],
  ["silent retained", "52627"],
] as const)("native background outcome: %s (%s)", async (scenario, startProcessId) => {
  const abort = new AbortController();
  const params = createTestParams();
  params.abortSignal = abort.signal;
  const source = new AbortController();
  const releaseSource = vi.fn();
  params.hostCapabilities = {
    ...params.hostCapabilities,
    retainSourceAuthority: retainSourceAuthority(source.signal, releaseSource),
  };
  const command = runningCommand(
    "retained-command",
    "synthetic-controlled-command",
    startProcessId,
  );
  const failedOutput = "Synthetic command failed after yielding";
  const complete = (patch: JsonObject): Promise<void> =>
    harness.notify(itemNotification("item/completed", { ...command, ...patch }));
  const harness = createStartedThreadHarness(async (method, input) => {
    if (method !== "thread/backgroundTerminals/list") {
      return undefined;
    }
    expect(input).toMatchObject({ threadId: "thread-1" });
    if (abort.signal.aborted) {
      return { data: [], nextCursor: null };
    }
    if (scenario === "inventory unavailable") {
      throw new Error("Synthetic inventory unavailable");
    }
    if (scenario === "completion during inventory") {
      await complete({
        processId: "52627",
        status: "failed",
        exitCode: 7,
        aggregatedOutput: failedOutput,
        durationMs: 1,
      });
    }
    if (scenario === "revoked during inventory") {
      abort.abort(new Error("Synthetic source revoked during inventory"));
    }
    return {
      data: [
        {
          itemId: scenario === "foreign item" ? "another-command" : command.id,
          processId: scenario === "foreign process" ? "another-process" : "52627",
        },
      ],
      nextCursor: null,
    };
  });
  const run = runCodexAppServerAttempt(params);
  try {
    await run.waitForTurnAccepted();
    await harness.notify(itemNotification("item/started", command));
    await harness.notify(answerCompleted(scenario.startsWith("silent") ? "NO_REPLY" : "Retained."));
    const result = await run;
    const tool = result.messagesSnapshot.find(
      (message) => message.role === "toolResult" && message.toolCallId === command.id,
    );
    if (scenario.endsWith("retained")) {
      expect(readAttemptTerminal(result).promptError).toBeNull();
      expect(tool).toMatchObject({
        isError: false,
        content: [{ type: "text", text: expect.stringContaining("still running") }],
        __openclaw: { toolOutput: { outcome: "unknown" } },
      });
      expect(JSON.stringify(tool)).toContain("52627");
      const unsubscribe = { method: "thread/unsubscribe", params: { threadId: "thread-1" } };
      const evictIdleThreads = async (phase: string) => {
        for (let index = 0; index < 65; index += 1) {
          await retainCodexAppServerLiveThread(harness.client, `idle-${phase}-${index}`);
        }
      };
      await evictIdleThreads("before");
      expect(harness.requests).not.toContainEqual(unsubscribe);
      await harness.notify({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "foreign-turn",
          item: { ...command, processId: "52627" },
        },
      });
      await complete({ processId: "foreign-process" });
      await evictIdleThreads("foreign");
      expect(harness.requests).not.toContainEqual(unsubscribe);
      if (startProcessId === null) {
        source.abort(new Error("Synthetic retained source revoked"));
      } else {
        await complete({ processId: "52627", status: "completed", exitCode: 0 });
      }
      await evictIdleThreads("after");
      expect(harness.requests).toContainEqual(unsubscribe);
      expect(releaseSource).toHaveBeenCalled();
    } else {
      expect(tool).toMatchObject({ isError: true });
      if (scenario === "completion during inventory") {
        expect(tool).toMatchObject({ content: [{ type: "text", text: failedOutput }] });
      }
      expect(JSON.stringify(tool)).not.toContain('"outcome":"unknown"');
    }
  } finally {
    source.abort(new Error("fixture cleanup"));
    abort.abort(new Error("fixture cleanup"));
    harness.close();
    await Promise.allSettled([run]);
  }
});

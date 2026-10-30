import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CliBackendExecuteContext,
  CliBackendMessageInjection,
  CliBackendToolPermissionResult,
  CliBackendTurnStatus,
} from "openclaw/plugin-sdk/cli-backend";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  withinTest,
  type FixtureReceiptChannel,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CLAUDE_PROTOCOL_FIXTURE } from "./cli-runtime.protocol.test-support.js";
import {
  collectClaudeCli,
  createCliTestHarness,
  prepareClaudeCli,
  resultDetail,
  waitForProcessExit,
} from "./cli-runtime.test-support.js";
import { executeClaudeCli, type ClaudeCliExecuteContext } from "./cli.runtime.js";

const harness = createCliTestHarness("openclaw-claude-protocol-");
const createLiveSession = harness.liveSession.bind(harness);
const INPUT = "synthetic user input";
const SYSTEM = "synthetic operator instructions";
const PRIVATE = "current private context";
const SESSION_ID = "a174e16f-b6e9-48da-ad5a-c437dfc2f9b4";
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

afterEach(async () => {
  await harness.cleanup();
  vi.restoreAllMocks();
});

const denied = (): CliBackendToolPermissionResult => ({
  behavior: "deny",
  message: "Fixture denied.",
});
const allowInput: NonNullable<CliBackendExecuteContext["requestToolPermission"]> = async ({
  toolInput,
}) => ({ behavior: "allow", updatedInput: toolInput });
const permission = (
  handler: CliBackendExecuteContext["requestToolPermission"] = async () => denied(),
) => vi.fn(handler);
async function createContext(
  scenario = "normal",
  overrides: Partial<ClaudeCliExecuteContext> = {},
) {
  const liveSession = overrides.liveSession ?? createLiveSession();
  const context = await harness.context(
    fixtureReceiptClientSource(receipts.endpoint) + "\n" + CLAUDE_PROTOCOL_FIXTURE,
    {
      prompt: INPUT,
      systemPrompt: SYSTEM,
      liveSession,
      requestToolPermission: permission(),
      requestUserInput: vi.fn<CliBackendExecuteContext["requestUserInput"]>(async () => ({
        status: "cancelled",
        message: "No question expected.",
      })),
      ...overrides,
    },
    { CLAUDE_FIXTURE_SCENARIO: scenario },
  );
  return { ...context, liveSession };
}
const collect = (
  context: CliBackendExecuteContext,
  overrides?: Partial<CliBackendExecuteContext>,
) => collectClaudeCli(overrides ? { ...context, ...overrides } : context);
const runDetail = async (
  context: CliBackendExecuteContext,
  overrides?: Partial<CliBackendExecuteContext>,
) => resultDetail(await collect(context, overrides));
const fixtureFile = (context: CliBackendExecuteContext, name: string) =>
  path.join(context.cwd, name);
const readFixture = (context: CliBackendExecuteContext, name: string) =>
  readFile(fixtureFile(context, name), "utf8");
const releaseFixture = (context: CliBackendExecuteContext, name: string) =>
  writeFile(fixtureFile(context, `${name}.release`), "release");
function expectRetired(context: CliBackendExecuteContext, pid: number) {
  expect(context.liveSession?.current()).toBeUndefined();
  expect(() => process.kill(pid, 0)).toThrow();
}

function killRemaining(pids: number[]) {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

function expectFinalResults(records: Record<string, unknown>[], count?: number) {
  const results = records.filter((record) => record.type === "result");
  if (count !== undefined) {
    expect(results).toHaveLength(count);
  }
  for (const interim of results.slice(0, -1)) {
    expect(interim).toHaveProperty("openclaw_interim_result", true);
  }
  expect(results.at(-1)).not.toHaveProperty("openclaw_interim_result");
}

async function expectWarmResume(
  context: CliBackendExecuteContext,
  detail: Record<string, unknown>,
  overrides: Partial<CliBackendExecuteContext> = {},
) {
  const handle = context.liveSession?.current();
  expect(handle?.isIdle()).toBe(true);
  expect(
    await runDetail(context, { prompt: "next input", useResume: true, ...overrides }),
  ).toMatchObject({
    pid: detail.pid,
    turn: 2,
    user: "next input",
  });
  expect(context.liveSession?.current()).toBe(handle);
}

async function startInjection(scenario: string, overrides: Partial<CliBackendExecuteContext> = {}) {
  let injection: CliBackendMessageInjection | undefined;
  const context = await createContext(scenario, {
    ...overrides,
    registerMessageInjection: (value) => {
      injection = value;
    },
  });
  const running = collect(context);
  void running.catch(() => {});
  await receipts.waitFor(fixtureFile(context, "turn.ready"), "ready");
  expect(injection?.isAvailable()).toBe(true);
  if (!injection) {
    throw new Error("Expected native message injection");
  }
  return { context, running, injection };
}

async function fixtureReadyBeforeSettlement(
  context: CliBackendExecuteContext,
  fileName: string,
  operation: PromiseLike<unknown>,
  signal: AbortSignal,
): Promise<void> {
  const readyPath = fixtureFile(context, fileName);
  const recorded = async () => {
    expect(await readFile(readyPath, "utf8")).toBe("ready");
  };
  // The fixture writes this record before replying; receipt and protocol pipes are unordered.
  const settled = Promise.resolve(operation).then(recorded, async (error: unknown) => {
    try {
      await recorded();
    } catch {
      throw error;
    }
  });
  await withinTest(Promise.race([receipts.waitFor(readyPath, "ready"), settled]), signal);
}

describe("Claude native stdio boundary", () => {
  it.for([
    { scenario: "shutdown-ignore", name: "native parent and child ignore EOF and SIGTERM" },
    { scenario: "shutdown-eof", name: "native parent exits immediately on EOF" },
  ])("reaps the native process tree when $name", async ({ scenario }, { signal }) => {
    const context = await createContext(scenario);
    const iterator = executeClaudeCli(context)[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.value).toMatchObject({
      subtype: "fixture_shutdown",
      pid: expect.any(Number),
      descendantPid: expect.any(Number),
    });
    const pids = [Number(first.value?.pid), Number(first.value?.descendantPid)];
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(4_000)]);
    try {
      await withinTest(
        (async () => {
          await iterator.return?.();
          await waitForProcessExit(pids, deadline);
        })(),
        deadline,
      );
      expect(context.liveSession!.current()).toBeUndefined();
    } finally {
      killRemaining(pids);
    }
  });

  it.each([false, true])("joins cleanup before replacement (fails: %s)", async (fails) => {
    const gate = createDeferred<void>();
    const failure = new Error("artifact cleanup failed");
    const cleanupStarted = createDeferred<void>();
    const liveSession = createLiveSession(() => {
      cleanupStarted.resolve();
      return gate.promise;
    });
    const context = await createContext("normal", { liveSession, sessionId: SESSION_ID });
    const first = await runDetail(context);
    liveSession.fingerprint = "changed-authoritative-prompt";
    const pending = collect(context, {
      useResume: true,
      systemPrompt: "changed authoritative instructions",
    });
    void pending.catch(() => {});
    try {
      await cleanupStarted.promise;
      expect(liveSession.current()).toBeUndefined();
      if (fails) {
        gate.reject(failure);
        await expect(pending).rejects.toBe(failure);
      } else {
        gate.resolve();
        const second = resultDetail(await pending);
        expect(second.pid).not.toBe(first.pid);
        expect(second).toMatchObject({
          turn: 1,
          argv: expect.arrayContaining(["--resume", context.sessionId]),
          initialize: {
            appendSystemPrompt: "changed authoritative instructions",
            systemPromptSnapshot: false,
          },
        });
      }
      expect(() => process.kill(Number(first.pid), 0)).toThrow();
      if (fails) {
        expect(liveSession.current()).toBeUndefined();
      }
    } finally {
      gate.resolve();
    }
  });

  it("rejects startup when the owner refuses capture", async () => {
    const liveSession = createLiveSession();
    const reason = new Error("Synthetic capture owner rejected this run.");
    liveSession.activate = () => {
      throw reason;
    };
    const context = await createContext("normal", { liveSession });
    await expect(collect(context)).rejects.toBe(reason);
    expect(liveSession.current()).toBeUndefined();
    await expect(access(fixtureFile(context, "fixture.pid"))).rejects.toThrow();
  });

  it.each([
    "background-success",
    "background-agent-subagent-bash-completed",
    "background-agent-subagent-bash-stopped",
    "background-parent-stopped-child-completed",
    "background-parent-stopped-child-stopped",
    "background-agent-foreground-bash",
    "background-agent-foreground-bash-run-ids",
  ])("preserves parent result ownership and warm reuse for %s", async (scenario) => {
    const liveSession = createLiveSession();
    const release = createDeferred<CliBackendToolPermissionResult>();
    const decision = { behavior: "deny" as const, message: "Fixture released." };
    const context = await createContext(scenario, {
      liveSession,
      requestToolPermission: () => release.promise,
    });
    const results: Record<string, unknown>[] = [];
    try {
      for await (const record of executeClaudeCli(context)) {
        if (record.type !== "result") {
          continue;
        }
        results.push(record);
        if (results.length === 1) {
          expect(record).toHaveProperty("openclaw_interim_result", true);
          expect(liveSession.current()?.isIdle()).toBe(false);
          release.resolve(decision);
        }
      }
    } finally {
      release.resolve(decision);
    }
    expectFinalResults(
      results,
      scenario.startsWith("background-parent-stopped")
        ? 4
        : scenario === "background-success" || scenario.startsWith("background-agent-foreground")
          ? 2
          : 3,
    );
    const detail = resultDetail(results);
    expect(detail.finalBackgroundAnswer).toBe(true);
    await expectWarmResume(context, detail);
  });

  it.each(["late-child", "late-child-run-ids"])(
    "retires the process when a prior turn's Agent child outlives it for %s",
    async (scenario) => {
      const context = await createContext(scenario);
      const first = await runDetail(context, { prompt: "first input" });
      expect(first.childLaunched).toBe(true);
      // The child would resume its Agent during a later input and act with that input's
      // tool and MCP authority, so the process cannot stay warm.
      expect(context.liveSession.current()).toBeUndefined();
      const next = await runDetail(context, { prompt: "next input", useResume: true });
      expect(next).toMatchObject({ childLaunched: true, turn: 1 });
      expect(next.pid).not.toBe(first.pid);
    },
  );

  const allowRead = { behavior: "allow" as const, updatedInput: { file_path: "approved.txt" } };
  it.for([
    ["success", false, true, "local_bash"],
    ["batched", true, true, "local_bash"],
    ["early", true, true, "local_bash"],
    ["inline", true, true, "local_bash"],
    ["overlap", true, true, "local_bash"],
    ["overlap", true, false, "local_bash"],
    ["overlap", true, false, "local_agent"],
  ] as const)(
    "applies host policy for background Bash %s",
    async ([variant, allow, replayReceipts, taskType], { signal }) => {
      const scenario = `background-bash-${variant}`;
      const decision = allow ? allowRead : denied();
      const context = await createContext(scenario, {
        requestToolPermission: permission(async () => decision),
      });
      if (!replayReceipts) {
        context.env.CLAUDE_FIXTURE_REPLAY_RECEIPTS = "0";
      }
      context.env.CLAUDE_FIXTURE_TASK_TYPE = taskType;
      let settled = false;
      const running = collect(context).then((records) => {
        settled = true;
        return records;
      });
      void running.catch(() => {});
      try {
        await fixtureReadyBeforeSettlement(context, "background.ready", running, signal);
        expect(settled).toBe(false);
      } finally {
        await releaseFixture(context, "background");
      }
      const records = await withinTest(running, signal);
      expectFinalResults(records, scenario === "background-bash-overlap" ? 3 : undefined);
      const detail = resultDetail(records);
      expect(detail.finalBackgroundAnswer).toBe(true);
      if (!replayReceipts) {
        expect(records).not.toContainEqual(
          expect.objectContaining({ type: "user", isReplay: true }),
        );
        await expectWarmResume(context, detail, { requestToolPermission: async () => denied() });
      }
      // Host policy, not the stale-run guard, answered the notification turn's hook.
      expect(detail.notificationDecision).toMatchObject({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: decision.behavior,
          ...(decision.behavior === "allow"
            ? { updatedInput: decision.updatedInput }
            : { permissionDecisionReason: decision.message }),
        },
      });
    },
  );

  it.for(["background-bash-captured-stopped", "background-bash-captured-stopped-overlap"])(
    "settles captured 2.1.286 shape for %s with same-process reuse",
    async (scenario, { signal }) => {
      const barrierReached = createDeferred<void>();
      const release = createDeferred<CliBackendToolPermissionResult>();
      const decision = { behavior: "deny" as const, message: "Fixture released." };
      const context = await createContext(scenario, {
        requestToolPermission: async ({ toolCallId, toolInput }) => {
          if (toolCallId !== "captured-release") {
            return { behavior: "allow", updatedInput: toolInput };
          }
          barrierReached.resolve();
          return release.promise;
        },
      });
      let settled = false;
      const running = collect(context).then((records) => {
        settled = true;
        return records;
      });
      void running.catch(() => {});
      try {
        await withinTest(Promise.race([barrierReached.promise, running]), signal);
        expect(settled).toBe(false);
      } finally {
        release.resolve(decision);
      }
      const records = await withinTest(running, signal);
      expectFinalResults(records, scenario.endsWith("-overlap") ? 2 : 1);
      const detail = resultDetail(records);
      expect(detail.capturedShapeAnswered).toBe(true);
      await expectWarmResume(context, detail);
    },
  );

  it.for([
    "background-bash-stopped-final",
    "background-bash-stopped-final-run-ids",
    "background-bash-stopped-final-slow",
    "background-bash-stopped-final-slow-run-ids",
  ])(
    "accepts the final answer after a TaskStopped auto-backgrounded Bash for %s",
    async (scenario, { signal }) => {
      const context = await createContext(scenario, {
        requestToolPermission: allowInput,
      });
      // Native sends nothing after this result; holding it would wait for the no-output watchdog.
      const records = await withinTest(collect(context), signal);
      expectFinalResults(records, 1);
      expect(records.at(-2)).toMatchObject({
        type: "assistant",
        message: { stop_reason: "end_turn" },
      });
      const detail = resultDetail(records);
      expect(detail).toMatchObject({ stoppedBashFinal: true, turn: 1 });
      await expectWarmResume(context, detail);
    },
  );

  it.each([false, true])("tracks first Bash (explicit: %s)", async (explicit) => {
    const context = await createContext("background-bash-first-seen", {
      requestToolPermission: allowInput,
    });
    context.env.CLAUDE_FIXTURE_EXPLICIT_BACKGROUND = explicit ? "1" : "0";
    const records = await collect(context);
    expectFinalResults(records, explicit ? 1 : 2);
    expect(context.liveSession?.current()?.isIdle()).toBe(true);
    if (explicit) {
      const first = resultDetail(records);
      const handle = context.liveSession?.current();
      expect(await runDetail(context, { useResume: true })).toMatchObject({
        firstSeenBackground: true,
        turn: 2,
        pid: first.pid,
      });
      expect(context.liveSession?.current()).toBe(handle);
    }
  });

  it.for(["abort", "process exit"])(
    "restarts fresh after pending Bash %s",
    async (termination, { signal }) => {
      const controller = new AbortController();
      let status: CliBackendTurnStatus | undefined;
      const context = await createContext("background-bash-success", {
        registerTurnStatus: (value) => {
          status = value;
        },
        abortSignal: controller.signal,
      });
      const { liveSession } = context;
      const running = collect(context);
      const outcome = running.catch((error: unknown) => error);
      let firstPid: number;
      try {
        await fixtureReadyBeforeSettlement(context, "background.ready", running, signal);
        firstPid = Number(await readFixture(context, "fixture.pid"));
        expect(liveSession.current()?.isIdle()).toBe(false);
        const assessment = status!.capture()!;
        if (termination === "abort") {
          controller.abort(new Error("Synthetic background turn cancelled."));
        } else {
          process.kill(firstPid, "SIGTERM");
        }
        expect(await withinTest(outcome, signal)).toBeInstanceOf(Error);
        expect(status!.capture() === undefined).toBe(termination === "abort");
        await expect(assessment.assess({ signal })).resolves.toEqual(
          termination === "process exit"
            ? { state: "closed", basis: "transport_closed" }
            : { state: "unknown", basis: "status_unsupported" },
        );
      } finally {
        controller.abort();
      }
      expectRetired(context, firstPid);
      const next = await runDetail(context, {
        useResume: true,
        env: { ...context.env, CLAUDE_FIXTURE_SCENARIO: "normal" },
        abortSignal: AbortSignal.timeout(10_000),
      });
      expect(next.turn).toBe(1);
      expect(next.pid).not.toBe(firstPid);
    },
  );

  it.for([
    { type: "token" as const, descriptor: "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR" },
    { type: "api_key" as const, descriptor: "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR" },
  ])(
    "uses a reopenable one-use $type descriptor and reaps its tree",
    async ({ type, descriptor }, { signal }) => {
      const context = await createContext("credential-tree");
      const credential = "synthetic-selected-descriptor-value";
      const prepared = await prepareClaudeCli(
        context,
        type === "token" ? { type, token: credential } : { type, key: credential },
      );
      Object.assign(context.env, prepared.env);
      const iterator = prepared.execute(context)[Symbol.asyncIterator]();
      let descendantPid: number | undefined;
      try {
        const first = await iterator.next();
        descendantPid = Number(first.value?.descendantPid);
        expect(context.env[descriptor]).toBe("3");
        expect(first.value).toMatchObject({
          subtype: "fixture_credential",
          descriptor: "3",
          digest: createHash("sha256").update(credential).digest("hex"),
          credentialInArgs: false,
          credentialInEnv: false,
        });
      } finally {
        await iterator.return?.();
        await prepared.cleanup();
      }
      try {
        await waitForProcessExit([descendantPid], signal);
      } finally {
        if (descendantPid) {
          killRemaining([descendantPid]);
        }
      }
    },
  );

  it.each([
    { check: "assertCurrent", decision: "deny" },
    { check: "assertPrivateInputCurrent", decision: "allow" },
  ] as const)(
    "settles awaited hooks after $check revocation as $decision",
    async ({ check, decision }) => {
      let active = true;
      const approvalStarted = createDeferred<void>();
      const approval = createDeferred<CliBackendToolPermissionResult>();
      const context = await createContext("revoked-approval", {
        [check]: () => {
          if (!active) {
            throw new Error("Synthetic owner revoked.");
          }
        },
        requestToolPermission: () => {
          approvalStarted.resolve();
          return approval.promise;
        },
      });
      const running = collect(context);
      await approvalStarted.promise;
      active = false;
      approval.resolve({ behavior: "allow", updatedInput: { file_path: "approved.txt" } });
      const detail = resultDetail(await running);
      expect(detail.hookDecision).toMatchObject({
        hookSpecificOutput: { permissionDecision: decision },
      });
      if (decision === "deny") {
        expect(detail.hookDecision).not.toHaveProperty("hookSpecificOutput.updatedInput");
      }
    },
  );

  it("isolates arguments, host permissions, and private context across warm turns", async () => {
    const context = await createContext("normal", {
      sessionId: SESSION_ID,
      useResume: true,
      promptContext: { prependContext: "private prefix", appendContext: "private suffix" },
      toolAvailability: { native: ["Read"], discovery: ["ToolSearch"], openClaw: ["message"] },
    });
    const nativeArgs = ["--fork-session", "--plugin-dir", "/tmp/synthetic-skills"];
    context.args = [
      ...context.args,
      ...nativeArgs,
      "--exclude-dynamic-system-prompt-sections",
      "--replay-user-messages",
      "--permission-mode",
      "bypassPermissions",
      "--allowedTools",
      "Bash",
      "mcp__openclaw__*",
    ];
    const detail = await runDetail(context);
    const args = detail.argv as string[];

    expect(args.slice(0, nativeArgs.length)).toEqual(nativeArgs);
    expect(args).toEqual(expect.arrayContaining(["--resume", context.sessionId]));
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain(context.systemPrompt);
    expect(args.filter((arg) => arg === "--replay-user-messages")).toHaveLength(1);
    const flag = (name: string) => {
      const start = args.indexOf(name);
      if (start === -1) {
        return [];
      }
      const end = args.findIndex((value, index) => index > start && value.startsWith("--"));
      return args
        .slice(start + 1, end === -1 ? undefined : end)
        .flatMap((value) => value.split(","));
    };
    expect(args).not.toContain("bypassPermissions");
    expect([flag("--permission-mode"), flag("--tools"), flag("--allowedTools")]).toEqual([
      ["default"],
      ["Read", "ToolSearch"],
      ["mcp__openclaw__message"],
    ]);
    expect(detail).toMatchObject({
      initialize: { appendSystemPrompt: SYSTEM, excludeDynamicSections: true },
      turn: 1,
      user: INPUT,
      synthetic: false,
      privateContext: "private prefix\n\nprivate suffix",
      permission: { behavior: "deny" },
    });
    const handle = context.liveSession.current();
    expect(
      await runDetail(context, {
        prompt: "Which color?",
        promptContext: { prependContext: "second private context" },
        promptOrigin: "host",
        useResume: true,
      }),
    ).toMatchObject({
      turn: 2,
      user: "Which color?",
      synthetic: true,
      privateContext: "second private context",
      pid: detail.pid,
    });
    expect(context.liveSession.current()).toBe(handle);
    expect(handle?.isIdle()).toBe(true);
  });

  it.each([
    ["mcp-hook", "hookDecision", { continue: true }],
    ["mcp-elicitation", "elicitation", { action: "decline" }],
  ] as const)("leaves %s controls outside host permissions", async (scenario, field, expected) => {
    const context = await createContext(scenario);
    const detail = await runDetail(context);
    expect(detail[field]).toEqual(expected);
    expect(context.requestUserInput).not.toHaveBeenCalled();
    expect(context.requestToolPermission).not.toHaveBeenCalled();
  });

  it("ignores replayed records until the current input UUID starts", async () => {
    const context = await createContext("input-lifecycle", {
      requestToolPermission: permission(allowInput),
    });
    for (const prompt of ["first input", "second input"]) {
      const records = await collect(context, {
        prompt,
        promptContext: { prependContext: PRIVATE },
      });
      expect(records.filter((record) => record.type === "result")).toHaveLength(1);
      expect(records).not.toContainEqual(expect.objectContaining({ type: "assistant" }));
      expect(records).not.toContainEqual(expect.objectContaining({ type: "stream_event" }));
      expect(records).not.toContainEqual(
        expect.objectContaining({ user_message_uuid: "prior-turn" }),
      );
      const detail = resultDetail(records);
      expect(detail).toMatchObject({ user: prompt, matchedInputUuid: expect.any(String) });
      if (prompt === "second input") {
        expect(detail.priorResponses).toMatchObject({
          "prior-pre": { hookSpecificOutput: { permissionDecision: "deny" } },
          "prior-permission": { behavior: "deny" },
        });
        expect((detail.priorResponses as Record<string, unknown>)["prior-context"]).toEqual({});
      }
    }
    expect(context.requestToolPermission).not.toHaveBeenCalled();
  });

  it.each([
    { scenario: "steer-merged", results: 1 },
    { scenario: "steer-merged", results: 1, samePrompt: true },
    { scenario: "steer-hook-repeat", results: 1 },
    { scenario: "steer-hook-rewrite", results: 1 },
    { scenario: "steer-after-result", results: 2 },
    { scenario: "steer-idle-trailer", results: 1 },
    { scenario: "steer-notification-replay", results: 2 },
    { scenario: "steer-completed-notification-replay", results: 2 },
  ])(
    "isolates steering context ($scenario, same prompt: $samePrompt)",
    async ({ scenario, results, samePrompt }) => {
      let status: CliBackendTurnStatus | undefined;
      const { context, running, injection } = await startInjection(scenario, {
        promptContext: { prependContext: PRIVATE },
        registerTurnStatus: (value) => {
          status = value;
        },
      });
      const captured = status!.capture()!;
      expect(captured.isCurrent()).toBe(true);
      await expect(captured.assess({ signal: new AbortController().signal })).resolves.toEqual({
        state: "unknown",
        basis: "process_present",
      });
      const notificationReplay = scenario.includes("notification-replay");
      const input = samePrompt
        ? context.prompt
        : notificationReplay
          ? "<task-notification><task-id>background-agent</task-id></task-notification>"
          : "steering input";
      const hook = scenario.startsWith("steer-hook-");
      const steering = { promptContext: { prependContext: "STEERING_PRIVATE_CONTEXT" } };
      await injection.queueMessage(
        input,
        async (submit) => {
          submit();
          expect(captured.isCurrent()).toBe(false);
        },
        hook ? steering : undefined,
      );
      const records = await running;
      const tagged = records.filter((record) => record.user_message_uuid !== undefined);
      expect(tagged.map((record) => record.type)).toEqual(
        expect.arrayContaining(["stream_event", "assistant", "result"]),
      );
      expect(new Set(tagged.map((record) => record.user_message_uuid)).size).toBe(1);
      expectFinalResults(records, results);
      const detail = resultDetail(records);
      expect(detail).toMatchObject({ user: input, privateContext: PRIVATE });
      if (scenario === "steer-merged") {
        expect(detail.hostFrames).toEqual([
          "control_request:initialize",
          "user",
          "control_response",
          "user",
          "control_response",
        ]);
      }
      expect(status!.capture()).toBeUndefined();
      if (notificationReplay) {
        expect(detail.finalBackgroundAnswer).toBe(true);
      }
      const additionalContext = steering.promptContext.prependContext;
      const expected = hook
        ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } }
        : {};
      expect(detail.injectedContext).toEqual(expected);
      expect(detail.injectedRerunContext).toEqual(hook ? expected : undefined);
      expect(injection.isAvailable()).toBe(false);
    },
  );

  it("rejects steering before admitted private context is submitted", async () => {
    let injection: CliBackendMessageInjection | undefined;
    const context = await createContext("steer-prompt-pending", {
      promptContext: { prependContext: PRIVATE },
      registerMessageInjection: (value) => {
        injection = value;
      },
    });
    const iterator = executeClaudeCli(context)[Symbol.asyncIterator]();
    try {
      expect((await iterator.next()).value).toMatchObject({ type: "system", subtype: "init" });
      expect(injection?.isAvailable()).toBe(false);
      await expect(
        injection!.queueMessage(context.prompt, async (submit) => submit()),
      ).rejects.toThrow("The Claude CLI turn cannot accept more input.");
    } finally {
      await iterator.return?.();
    }
  });

  it("rejects same-turn input the native process never started", async () => {
    const { running, injection } = await startInjection("steer-exit");
    await expect(
      injection.queueMessage("lost input", async (submit) => submit()),
    ).rejects.toThrow();
    await expect(running).rejects.toThrow();
  });

  it.each(["cancelled", "discarded", "refused", "completed"])(
    "settles %s input and releases held results",
    async (state) => {
      const { running, injection } = await startInjection(`steer-${state}`);
      const receipt = injection.queueMessage("terminal input", async (submit) => submit());
      if (state === "completed") {
        await expect(receipt).resolves.toBeUndefined();
      } else {
        await expect(receipt).rejects.toThrow(`Claude CLI ${state} the injected input.`);
      }
      expectFinalResults(await running, 1);
    },
  );

  it("rejects injected input when authority fails at the write", async () => {
    const { context, injection } = await startInjection("steer-merged");
    await expect(
      injection.queueMessage("revoked input", async () => {
        throw new Error("revoked");
      }),
    ).rejects.toThrow("revoked");
    expect(await readFixture(context, "user.received")).toBe(INPUT);
  });

  it("rejects pre-aborted runs before credential reads or process creation", async () => {
    const controller = new AbortController();
    const reason = new Error("Synthetic owner cancelled before startup.");
    controller.abort(reason);
    const context = await createContext("normal", { abortSignal: controller.signal });
    const createData = vi.fn(() => Buffer.from("synthetic unused credential"));
    await expect(collectClaudeCli(context, { fd: 3, createData })).rejects.toBe(reason);
    expect(createData).not.toHaveBeenCalled();
    await expect(access(fixtureFile(context, "fixture.pid"))).rejects.toThrow();
  });

  it.for(["assertCurrent", "assertPrivateInputCurrent"] as const)(
    "revalidates %s after initialization before sending input",
    async (check, { signal }) => {
      let active = true;
      const reason = new Error("Synthetic admitted owner was released.");
      const context = await createContext("revoked-initialize", {
        [check]: () => {
          if (!active) {
            throw reason;
          }
        },
      });
      const running = collect(context);
      const outcome = running.catch((error: unknown) => error);
      try {
        await fixtureReadyBeforeSettlement(context, "initialize.ready", running, signal);
        active = false;
      } finally {
        await releaseFixture(context, "initialize");
      }
      expect(await withinTest(outcome, signal)).toBe(reason);
      expect(context.liveSession.current()).toBeUndefined();
      await expect(access(fixtureFile(context, "user.received"))).rejects.toThrow();
    },
  );

  it("deduplicates native user questions across hook and permission callbacks", async () => {
    const requestUserInput = vi.fn(async () => ({
      status: "answered" as const,
      answers: { question_1: ["Shared flow"] },
    }));
    const context = await createContext("user-question", { requestUserInput });
    const detail = await runDetail(context);

    expect(detail.permission).toMatchObject({
      behavior: "allow",
      updatedInput: { answers: { "Which path should Claude take?": "Shared flow" } },
    });
    expect(requestUserInput).toHaveBeenCalledOnce();
    expect(context.requestToolPermission).not.toHaveBeenCalled();
  });

  it("cancels native permissions without blocking the protocol reader", async () => {
    let cancelled = false;
    const context = await createContext("cancel-permission", {
      requestToolPermission: permission(async ({ toolInput, abortSignal }) => {
        if (toolInput.file_path === "cancel.txt") {
          await new Promise<void>((resolve) => {
            if (abortSignal?.aborted) {
              resolve();
            } else {
              abortSignal?.addEventListener("abort", () => resolve(), { once: true });
            }
          });
          cancelled = true;
        }
        return denied();
      }),
    });

    const detail = await runDetail(context);

    expect(cancelled).toBe(true);
    expect(detail.cancelledDecision).toMatchObject({ behavior: "deny" });
  });

  it("fences background permission decisions after the next turn starts", async () => {
    const approval = createDeferred<CliBackendToolPermissionResult>();
    const context = await createContext("background-bash-late-approval", {
      requestToolPermission: permission(async ({ toolCallId }) =>
        toolCallId === "late-tool" ? approval.promise : denied(),
      ),
    });
    context.env.CLAUDE_FIXTURE_REPLAY_RECEIPTS = "0";
    await releaseFixture(context, "background");
    await collect(context);
    const records: Record<string, unknown>[] = [];
    for await (const record of executeClaudeCli({
      ...context,
      prompt: "next admitted turn",
      useResume: true,
    })) {
      records.push(record);
      if (record.subtype === "fixture_second_turn") {
        approval.resolve({ behavior: "allow", updatedInput: { command: "echo late" } });
      }
    }

    expect(resultDetail(records).lateDecision).toMatchObject({
      behavior: "deny",
      message: "The OpenClaw run is no longer active.",
    });
  });

  it("frames large records across UTF-8 byte boundaries", async () => {
    const records = await collect(await createContext("large-split-record"));
    expect(records).toContainEqual({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "🦞" + "x".repeat(300_000) + "🦞" }],
      },
    });
    expect(resultDetail(records).turn).toBe(1);
  });

  it.each([
    {
      scenario: "background-bash-queued-error",
      expected: { is_error: true, errors: ["fixture background turn failed"] },
    },
    {
      scenario: "background-bash-queued-raw-result",
      expected: { result: expect.stringContaining('<invoke name="Read">') },
    },
  ])("ends $scenario even with listed native background work", async ({ scenario, expected }) => {
    const context = await createContext(scenario);
    const records = await collect(context);
    expect(records.at(-1)).toMatchObject({ type: "result", ...expected });
    expect(records.at(-1)).not.toHaveProperty("openclaw_interim_result");
    const firstPid = Number(await readFixture(context, "fixture.pid"));
    expectRetired(context, firstPid);
    const second = await collect(context, { useResume: true });
    expect(second.at(-1)).toMatchObject({ type: "result", ...expected });
    const secondPid = Number(await readFixture(context, "fixture.pid"));
    expect(secondPid).not.toBe(firstPid);
    expect(context.liveSession.current()).toBeUndefined();
  });
  it("withholds private context when its authority is revoked after sending the prompt", async ({
    signal,
  }) => {
    let active = true;
    const context = await createContext("revoked-prompt", {
      prompt: "Remember orange.",
      promptContext: { prependContext: "saved private context" },
      assertPrivateInputCurrent: () => {
        if (!active) {
          throw new Error("Synthetic account reassigned after send.");
        }
      },
    });
    const running = collect(context);
    const outcome = running.catch((error: unknown) => error);
    try {
      await fixtureReadyBeforeSettlement(context, "prompt.ready", running, signal);
      expect(await readFixture(context, "user.received")).toBe("Remember orange.");
      active = false;
    } finally {
      await releaseFixture(context, "prompt");
      await withinTest(outcome, signal);
    }
    const detail = resultDetail(await running);
    expect(detail).toMatchObject({ turn: 1, user: "Remember orange." });
    expect(detail.privateContext).toBeUndefined();
  });
});

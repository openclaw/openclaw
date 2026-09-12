import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { CliBackendConfig, CliBackendExecute } from "../../plugins/cli-backend.types.js";
import { PluginInstance } from "../../plugins/plugin-instance.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { createTestAdmittedRunContext } from "../admitted-run-context.test-support.js";
import { executePreparedCliRun } from "./execute.js";
import { retainCliPluginExecutionConsumer } from "./execution-target.js";
import type { PreparedCliRunContext } from "./types.js";

const SUCCESS_RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "completed",
  session_id: "sdk-session",
};

async function preparePluginContext(execute: CliBackendExecute): Promise<{
  context: PreparedCliRunContext;
  admission: ReturnType<typeof prepareSystemAgentRunAdmission>;
}> {
  const backend: CliBackendConfig = {
    command: "/bin/sh",
    args: [],
    output: "jsonl",
    jsonlDialect: "claude-stream-json",
    input: "stdin",
    sessionMode: "existing",
  };
  const runId = "plugin-reload-run";
  const context: PreparedCliRunContext = {
    params: {
      admittedRunContext: createTestAdmittedRunContext(runId),
      sessionId: "s1",
      sessionFile: "/tmp/session.jsonl",
      workspaceDir: "/tmp",
      prompt: "hi",
      provider: "claude-cli",
      model: "opus",
      thinkLevel: "low",
      timeoutMs: 120_000,
      runId,
    },
    started: Date.now(),
    workspaceDir: "/tmp",
    backendResolved: { id: "claude-cli", config: backend, bundleMcp: false, pluginId: "anthropic" },
    executionTarget: { kind: "plugin", execute },
    pluginExecutionConsumer: retainCliPluginExecutionConsumer(execute),
    preparedBackend: { backend, env: {} },
    reusableCliSession: { mode: "none" },
    hadSessionFile: false,
    contextEngineConfig: {},
    modelId: "opus",
    normalizedModel: "opus",
    contextWindowInfo: { tokens: 150_000, referenceTokens: 200_000, source: "modelsConfig" },
    systemPrompt: "You are a helpful assistant.",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    claudeSkillsPluginArgs: [],
    authEpochVersion: 2,
  };
  const admission = prepareSystemAgentRunAdmission({}, runId, "main", "plugin-reload-test");
  context.params.admittedRunContext = await admission.admit("plugin-harness");
  return { context, admission };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("plugin-owned CLI turns across a plugin hot reload", () => {
  it("delivers a turn that outlives its backend instance's retirement", async () => {
    // A hot reload retires the previous plugin instance while the CLI turn is
    // still running; the finished reply and the turn's cleanup must still go
    // through instead of failing once the bounded call drain expires (#144809).
    vi.useFakeTimers();
    const owner = new PluginInstance("anthropic");
    const finish = createDeferred();
    let started = false;
    const execute = owner.wrap<CliBackendExecute>(async function* () {
      yield { type: "system", subtype: "init", session_id: "sdk-session" };
      started = true;
      await finish.promise;
      yield SUCCESS_RESULT;
    });
    const cleanup = owner.wrap(async () => {
      cleaned = true;
    });
    let cleaned = false;
    const { context, admission } = await preparePluginContext(execute);
    const consumer = context.pluginExecutionConsumer;
    expect(consumer).toBeDefined();
    let outcome: { ok: true; text: string } | { ok: false; error: unknown } | undefined;
    const run = executePreparedCliRun(context).then(
      (value) => {
        outcome = { ok: true, text: value.text };
      },
      (error: unknown) => {
        outcome = { ok: false, error };
      },
    );
    let disposal: ReturnType<typeof owner.dispose> | undefined;
    try {
      await vi.waitFor(() => expect(started).toBe(true));

      disposal = owner.dispose();
      await vi.advanceTimersByTimeAsync(5_001);
      expect(owner.acceptingCalls).toBe(false);
      finish.resolve();

      // Settle under fake timers so a regression fails on its own error instead of hanging.
      await vi.waitFor(() => expect(outcome).toBeDefined(), { timeout: 30_000, interval: 100 });
      expect(outcome, "CLI run did not settle after its plugin instance retired").toEqual({
        ok: true,
        text: "completed",
      });
      // Prepared cleanup runs inside the same retained scope before releasing it.
      await consumer!.run(cleanup);
      expect(cleaned).toBe(true);
      consumer!.release();
      await expect(disposal).resolves.toEqual({ errors: [] });
    } finally {
      // A failed assertion must not strand the iterator or its retained owner.
      finish.resolve();
      consumer?.release();
      admission.close();
      await Promise.allSettled([run, disposal ?? owner.dispose()]);
    }
  });
});

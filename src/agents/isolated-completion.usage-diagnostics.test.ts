import { beforeEach, expect, it, vi } from "vitest";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "../infra/diagnostic-events.js";
import {
  isolatedCompletionMocks as mocks,
  isolatedAssistant,
  isolatedRequest,
  preparedModelRuntime,
  registerIsolatedHarness,
  releaseRuntimeLease,
  resetIsolatedCompletionTestState,
  runIsolatedCompletion,
} from "./isolated-completion.test-support.js";

// Shape of a recap-sized CLI utility result: 10 input, 462 output, 4111 cache write.
const cliUsage = { input: 10, output: 462, cacheRead: 0, cacheWrite: 4111, total: 4583 };

beforeEach(() => {
  resetIsolatedCompletionTestState();
  resetDiagnosticEventsForTest();
});

function collectUsageEvents() {
  const events: unknown[] = [];
  const stop = onTrustedInternalDiagnosticEvent((event) => {
    if (event.type === "model.usage") {
      events.push(event);
    }
  });
  return { events, stop };
}

it("emits one model.usage event when a CLI isolated completion reports usage", async () => {
  mocks.isCliRuntimeAliasForProvider.mockReturnValue(true);
  mocks.runCliAgent.mockResolvedValue({
    payloads: [{ text: "done" }],
    meta: { agentMeta: { usage: cliUsage } },
  });
  const seen = collectUsageEvents();

  const result = await runIsolatedCompletion({
    ...isolatedRequest(),
    purpose: "session-activity-summary",
  });
  seen.stop();

  expect(result.text).toBe("done");
  expect(result.usage).toMatchObject(cliUsage);
  expect(seen.events).toHaveLength(1);
  expect(seen.events[0]).toMatchObject({
    type: "model.usage",
    agentId: "main",
    provider: "openai",
    model: "gpt-test",
    usage: {
      input: 10,
      output: 462,
      cacheRead: 0,
      cacheWrite: 4111,
      promptTokens: 4121,
      total: 4583,
    },
  });
});

it("emits one model.usage event from the harness path", async () => {
  const dispatch = vi.fn(async () => ({
    assistant: isolatedAssistant([{ type: "text", text: "done" }]),
  }));
  registerIsolatedHarness({ runIsolatedCompletionV2: dispatch });
  const seen = collectUsageEvents();

  await runIsolatedCompletion(isolatedRequest());
  seen.stop();

  expect(dispatch).toHaveBeenCalledOnce();
  expect(seen.events).toHaveLength(1);
  expect(seen.events[0]).toMatchObject({
    type: "model.usage",
    provider: "openai",
    model: "gpt-test",
  });
});

it("skips the central emission for plugin completions that finalize their own usage", async () => {
  mocks.isCliRuntimeAliasForProvider.mockReturnValue(true);
  mocks.runCliAgent.mockResolvedValue({
    payloads: [{ text: "done" }],
    meta: { agentMeta: { usage: cliUsage } },
  });
  const seen = collectUsageEvents();

  const result = await runIsolatedCompletion({
    ...isolatedRequest(),
    purpose: "plugin-completion",
  });
  seen.stop();

  expect(result.text).toBe("done");
  expect(seen.events).toEqual([]);
});

it("emits nothing when diagnostics are disabled", async () => {
  // The run's admission snapshot owns the config, so the gate reads it from there.
  mocks.acquireAgentRunPreparedModelRuntime.mockResolvedValue({
    snapshot: { ...preparedModelRuntime, config: { diagnostics: { enabled: false } } },
    [Symbol.asyncDispose]: releaseRuntimeLease,
  });
  mocks.isCliRuntimeAliasForProvider.mockReturnValue(true);
  mocks.runCliAgent.mockResolvedValue({
    payloads: [{ text: "done" }],
    meta: { agentMeta: { usage: cliUsage } },
  });
  const seen = collectUsageEvents();

  await runIsolatedCompletion({ ...isolatedRequest(), purpose: "session-activity-summary" });
  seen.stop();

  expect(seen.events).toEqual([]);
});

it("emits nothing when the CLI runtime reports no usage", async () => {
  mocks.isCliRuntimeAliasForProvider.mockReturnValue(true);
  mocks.runCliAgent.mockResolvedValue({ payloads: [{ text: "done" }] });
  const seen = collectUsageEvents();

  await runIsolatedCompletion({ ...isolatedRequest(), purpose: "session-activity-summary" });
  seen.stop();

  expect(seen.events).toEqual([]);
});

import { beforeEach, expect, it } from "vitest";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "../infra/diagnostic-events.js";
import {
  isolatedAssistant,
  isolatedCompletionMocks as mocks,
  isolatedRequest,
  registerIsolatedHarness,
  resetIsolatedCompletionTestState,
  runIsolatedCompletion,
} from "./isolated-completion.test-support.js";

beforeEach(() => {
  resetIsolatedCompletionTestState();
  resetDiagnosticEventsForTest();
});

async function collectUsageEvents(run: () => Promise<unknown>) {
  const events: unknown[] = [];
  const stop = onTrustedInternalDiagnosticEvent((event) => {
    if (event.type === "model.usage") {
      events.push(event);
    }
  });
  try {
    await run();
  } finally {
    stop();
  }
  return events;
}

const cliUsage = { input: 10, output: 462, cacheRead: 0, cacheWrite: 4111, total: 4583 };

function useCliRuntime(agentMeta: object = { usage: cliUsage }) {
  mocks.isCliRuntimeAliasForProvider.mockReturnValue(true);
  mocks.runCliAgent.mockResolvedValue({ payloads: [{ text: "done" }], meta: { agentMeta } });
}

it("emits one model.usage for a completed CLI completion", async () => {
  useCliRuntime();
  const events = await collectUsageEvents(() =>
    runIsolatedCompletion({ ...isolatedRequest(), purpose: "session-activity-summary" }),
  );
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    agentId: "main",
    provider: "openai",
    model: "gpt-test",
    usage: { input: 10, output: 462, cacheWrite: 4111, total: 4583 },
  });
});

it("reports the terminal CLI turn usage when the backend provides it", async () => {
  useCliRuntime({ usage: { input: 1, output: 1 }, diagnosticUsage: cliUsage });
  const events = await collectUsageEvents(() => runIsolatedCompletion(isolatedRequest()));
  expect(events).toMatchObject([{ usage: { output: 462, total: 4583 } }]);
});

it("emits one model.usage for a completed harness completion", async () => {
  registerIsolatedHarness({
    runIsolatedCompletionV2: async () => ({
      assistant: isolatedAssistant([{ type: "text", text: "done" }]),
    }),
  });
  const events = await collectUsageEvents(() => runIsolatedCompletion(isolatedRequest()));
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    provider: "openai",
    model: "gpt-test",
    usage: { input: 1, output: 1, total: 2 },
  });
});

it("emits nothing for a harness completion that reports no usage", async () => {
  const assistant = isolatedAssistant([{ type: "text", text: "done" }]);
  registerIsolatedHarness({
    runIsolatedCompletionV2: async () => ({
      assistant: {
        ...assistant,
        usage: { ...assistant.usage, input: 0, output: 0, totalTokens: 0 },
      },
    }),
  });
  const events = await collectUsageEvents(() => runIsolatedCompletion(isolatedRequest()));
  expect(events).toEqual([]);
});

it("leaves plugin completions to their own usage finalizer", async () => {
  useCliRuntime();
  const events = await collectUsageEvents(() =>
    runIsolatedCompletion({ ...isolatedRequest(), purpose: "plugin-completion" }),
  );
  expect(events).toEqual([]);
});

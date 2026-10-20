import { beforeEach, expect, it } from "vitest";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "../infra/diagnostic-events.js";
import type { IsolatedCompletionPurpose } from "./isolated-completion-purpose.js";
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

async function collectUsageEvents(purpose?: IsolatedCompletionPurpose) {
  const events: unknown[] = [];
  const stop = onTrustedInternalDiagnosticEvent((event) => {
    if (event.type === "model.usage") {
      events.push(event);
    }
  });
  try {
    await runIsolatedCompletion({ ...isolatedRequest(), purpose });
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

function useHarness(assistant = isolatedAssistant([{ type: "text", text: "done" }])) {
  registerIsolatedHarness({ runIsolatedCompletionV2: async () => ({ assistant }) });
}

it.each([
  [
    "cli",
    "session-activity-summary",
    { input: 10, output: 462, cacheWrite: 4111, total: 4583 },
    useCliRuntime,
  ],
  ["harness", undefined, { input: 1, output: 1, total: 2 }, useHarness],
] as const)(
  "emits one model.usage for a completed %s completion",
  async (runtimeKind, purpose, usage, setup) => {
    setup();
    expect(await collectUsageEvents(purpose)).toMatchObject([
      {
        agentId: "main",
        provider: "openai",
        model: "gpt-test",
        purpose: purpose ?? "isolated-completion",
        runtimeKind,
        usage,
      },
    ]);
  },
);

it("reports the terminal CLI turn usage when the backend provides it", async () => {
  useCliRuntime({ usage: { input: 1, output: 1 }, diagnosticUsage: cliUsage });
  const events = await collectUsageEvents();
  expect(events).toMatchObject([{ usage: { output: 462, total: 4583 } }]);
});

it("emits nothing for a harness completion that reports no usage", async () => {
  const assistant = isolatedAssistant([{ type: "text", text: "done" }]);
  useHarness({
    ...assistant,
    usage: { ...assistant.usage, input: 0, output: 0, totalTokens: 0 },
  });
  expect(await collectUsageEvents()).toEqual([]);
});

it("leaves plugin completions to their own usage finalizer", async () => {
  useCliRuntime();
  expect(await collectUsageEvents("plugin-completion")).toEqual([]);
});

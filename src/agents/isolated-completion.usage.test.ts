import { beforeEach, expect, it } from "vitest";
import {
  onTrustedInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "../infra/diagnostic-events.js";
import type { IsolatedCompletionPurpose } from "./isolated-completion-purpose.js";
import * as fixtures from "./isolated-completion.test-support.js";
const mocks = fixtures.isolatedCompletionMocks;

beforeEach(() => {
  fixtures.resetIsolatedCompletionTestState();
  resetDiagnosticEventsForTest();
});
const cliUsage = { input: 10, output: 462, cacheRead: 0, cacheWrite: 4111, total: 4583 };
type UsageCase = "cli" | "diagnostic-cli" | "harness" | "empty-harness";

async function collectUsage(kind: UsageCase, purpose?: IsolatedCompletionPurpose) {
  if (kind === "cli" || kind === "diagnostic-cli") {
    mocks.isCliRuntimeAliasForProvider.mockReturnValue(true);
    const usage = kind === "cli" ? cliUsage : { input: 1, output: 1 };
    const agentMeta = {
      usage,
      ...(kind === "diagnostic-cli" ? { diagnosticUsage: cliUsage } : {}),
    };
    const payloads = [{ text: "done" }];
    mocks.runCliAgent.mockResolvedValue({ payloads, meta: { agentMeta } });
  } else {
    const assistant = fixtures.isolatedAssistant([{ type: "text", text: "done" }]);
    if (kind === "empty-harness") {
      assistant.usage = { ...assistant.usage, input: 0, output: 0, totalTokens: 0 };
    }
    fixtures.registerIsolatedHarness({ runIsolatedCompletionV2: async () => ({ assistant }) });
  }
  const events: unknown[] = [];
  const stop = onTrustedInternalDiagnosticEvent((event) => {
    if (event.type === "model.usage") {
      events.push(event);
    }
  });
  try {
    await fixtures.runIsolatedCompletion({ ...fixtures.isolatedRequest(), purpose });
    return events;
  } finally {
    stop();
  }
}

it.each([
  ["cli", "session-activity-summary", { input: 10, output: 462, cacheWrite: 4111, total: 4583 }],
  ["harness", undefined, { input: 1, output: 1, total: 2 }],
] as const)("reports completed %s usage", async (runtimeKind, purpose, usage) => {
  expect(await collectUsage(runtimeKind, purpose)).toMatchObject([
    {
      agentId: "main",
      provider: "openai",
      model: "gpt-test",
      purpose: purpose ?? "isolated-completion",
      runtimeKind,
      usage,
    },
  ]);
});

it("reports terminal CLI turn usage", async () => {
  expect(await collectUsage("diagnostic-cli")).toMatchObject([
    { usage: { output: 462, total: 4583 } },
  ]);
});

it.each([
  ["empty-harness", undefined],
  ["cli", "plugin-completion"],
] as const)("emits no usage for %s / %s", async (kind, purpose) => {
  expect(await collectUsage(kind, purpose)).toEqual([]);
});

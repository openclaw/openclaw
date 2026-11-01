import type { Context } from "openclaw/plugin-sdk/llm";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { readNestedToolActivity } from "../../../sessions/nested-tool-activity.js";
import { pluginToolWithExecute, resetCodeModeTestState } from "../../code-mode.test-support.js";
import { Agent } from "../../runtime/index.js";
import { SessionManager } from "../../sessions/session-manager.js";
import { fakeTool } from "../../test-helpers/fake-tool.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { isToolResultError } from "../../tool-result-error.js";
import { jsonResult } from "../../tools/common.js";
import {
  createAgentBackedAttemptSession,
  streamAttemptAssistant,
  attemptToolCall,
} from "./attempt-agent.test-support.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

const hoisted = getHoisted();
const tempPaths: string[] = [];
const model = makeProviderModelFixture({
  id: "test-model",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.test",
});

beforeAll(preloadRunEmbeddedAttemptForTests);
beforeEach(() => resetEmbeddedAttemptHarness());

afterEach(async () => {
  await resetCodeModeTestState();
  await cleanupTempPaths(tempPaths);
});

it("keeps the normal Code Mode surface through failure, inspection, and multiple edits", async () => {
  const sessionManager = SessionManager.inMemory();
  const appliedChanges: string[] = [];
  const read = fakeTool("read", "Inspect current file contents");
  const shell = fakeTool("shell_command", "Inspect source through a shell");
  const applyPatch = pluginToolWithExecute("apply_patch", "Apply a patch", async () => {
    appliedChanges.push("first hunk applied");
    throw new Error("second hunk is ambiguous");
  });
  const write = pluginToolWithExecute("write", "Write a file", async (_id, input) => {
    appliedChanges.push((input as { value: string }).value);
    return jsonResult({ written: true });
  });
  hoisted.createOpenClawCodingToolsMock.mockReturnValue([read, shell, applyPatch, write]);

  const programs = [
    "return await apply_patch({});",
    "return await shell_command({});",
    'return await write({ value: "second hunk applied" });',
    'return await write({ value: "third hunk applied" });',
    "return await read({});",
  ];
  const providerContexts: Context[] = [];
  const createSession = () =>
    createAgentBackedAttemptSession(
      (_model, tools) =>
        new Agent({
          initialState: { model, tools },
          afterToolCall: async ({ result, isError }) => ({
            isError: isError || isToolResultError(result),
          }),
          streamFn: (_activeModel, context) => {
            const turn = providerContexts.length;
            providerContexts.push(context);
            const code = programs[turn];
            return streamAttemptAssistant(
              model,
              code === undefined
                ? [{ type: "text", text: "all changes verified" }]
                : attemptToolCall(`program-${turn}`, "exec", {
                    title: "Continue the source repair",
                    code,
                  }),
            );
          },
        }),
    );

  const result = await createContextEngineAttemptRunner({
    contextEngine: createContextEngineBootstrapAndAssemble(),
    createSession,
    sessionKey: "agent:main:main",
    tempPaths,
    attemptOverrides: {
      config: { tools: { codeMode: true } },
      sessionManager,
      disableMessageTool: false,
      disableTools: false,
      model,
    },
  });

  expect(providerContexts).toHaveLength(6);
  for (const context of providerContexts) {
    expect(context.tools?.map((tool) => tool.name)).toContain("exec");
  }
  expect(providerContexts[1]?.messages).toContainEqual(
    expect.objectContaining({
      role: "toolResult",
      isError: true,
      content: [
        expect.objectContaining({ text: expect.stringContaining("second hunk is ambiguous") }),
      ],
    }),
  );
  expect(appliedChanges).toEqual([
    "first hunk applied",
    "second hunk applied",
    "third hunk applied",
  ]);
  expect(result.messagesSnapshot.at(-1)).toMatchObject({
    role: "assistant",
    content: [{ type: "text", text: "all changes verified" }],
  });
  const activities = sessionManager.getEntries().flatMap((entry) => {
    const activity = entry.type === "message" && readNestedToolActivity(entry.message);
    return activity ? [activity.details] : [];
  });
  expect(
    activities.map(({ toolName, isError, parentToolCallId }) => [
      toolName,
      isError,
      parentToolCallId,
    ]),
  ).toEqual([
    ["apply_patch", true, "program-0"],
    ["shell_command", false, "program-1"],
    ["write", false, "program-2"],
    ["write", false, "program-3"],
    ["read", false, "program-4"],
  ]);
});

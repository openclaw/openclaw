import { expect, it } from "vitest";
import { respondOpenAi, userInputs } from "./server.fixtures.test-support.js";
import {
  createMockServerTestHarness,
  outputItems,
  outputText,
  outputToolArgsFromItem,
  outputToolCall,
} from "./server.test-harness.js";

const { startMockServer } = createMockServerTestHarness();

it.each([
  {
    tool: "ls",
    prompt:
      'tool search qa failure target=ls. Call ls exactly once with path="runtime-tool-fixture-missing-directory" to exercise the missing-directory failure. Do not create the directory or retry.',
    args: { path: "runtime-tool-fixture-missing-directory" },
  },
  {
    tool: "sessions_spawn",
    prompt:
      'QA routing marker: tool search qa failure target=sessions_spawn. Call sessions_spawn directly exactly once with task="". Do not repair, omit, replace, or retry the empty task. Do not call tool_search. Summarize the actual rejection.',
    args: { task: "" },
  },
])(
  "plans the new invalid $tool call despite older output and negated retry",
  async ({ tool, prompt, args }) => {
    const server = await startMockServer();
    const payload = await respondOpenAi(
      server,
      userInputs(
        "Read the setup file.",
        { type: "function_call", name: "read", call_id: "setup-read", arguments: "{}" },
        { type: "function_call_output", call_id: "setup-read", output: "Setup is complete." },
        `<conversation_context>
[user]
Continue the earlier task.
</conversation_context>

Current user request:
${prompt}`,
      ),
      { tools: [{ type: "function", name: tool, parameters: { type: "object" } }] },
    );
    expect(outputToolArgsFromItem(outputToolCall(payload, tool))).toEqual(args);
  },
);

it("still spawns the cron child when a notification follows the prompt", async () => {
  const server = await startMockServer();
  const payload = await respondOpenAi(
    server,
    userInputs("Cron one-shot QA mode=spawn", {
      type: "function_call_output",
      name: "notifications",
      namespace: "slack",
      output: "An unrelated notification.",
    }),
    { tools: [{ type: "function", name: "sessions_spawn", parameters: { type: "object" } }] },
  );
  expect(outputToolArgsFromItem(outputToolCall(payload, "sessions_spawn"))).toMatchObject({
    label: "qa-one-shot-child",
    mode: "run",
  });
});

// stalled-turn-recovery.ts -> transcript-followup-run.ts -> formatSystemTurnPrompt.
it("does not reissue a completed call after a producer-shaped stalled recovery", async () => {
  const server = await startMockServer();
  const payload = await respondOpenAi(
    server,
    userInputs(
      "tool search qa check target=ls. Call ls exactly once and then summarize.",
      { type: "function_call", name: "ls", call_id: "completed-ls", arguments: '{"path":"."}' },
      { type: "function_call_output", call_id: "completed-ls", output: "synthetic-result.txt" },
      "[System] Your previous turn was interrupted. Continue the user's request from the transcript and any newer message. Reconcile pending actions before retrying; do not repeat completed work. Finish and verify the remaining work, or explain the blocker.",
    ),
    { tools: [{ type: "function", name: "ls", parameters: { type: "object" } }] },
  );
  expect(outputItems(payload)).not.toContainEqual(
    expect.objectContaining({ type: "function_call" }),
  );
  expect(outputText(payload)).toContain("synthetic-result.txt");
});

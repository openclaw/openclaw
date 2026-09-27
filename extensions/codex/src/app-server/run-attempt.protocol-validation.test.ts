import { describe, expect, it } from "vitest";
import type { JsonObject } from "./protocol.js";
import { turnCompleted } from "./protocol.test-helpers.js";
import {
  createStartedThreadHarness,
  createTestParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
} from "./run-attempt-test-harness.js";

setupRunAttemptTestHooks();

describe("Codex native completion validation", () => {
  it.each<{ label: string; turn: JsonObject }>([
    { label: "missing items", turn: {} },
    { label: "non-array items", turn: { items: "invalid" } },
    { label: "nonterminal status", turn: { status: "inProgress", items: [] } },
    {
      label: "missing dynamic tool status",
      turn: { items: [{ id: "tool-1", type: "dynamicToolCall", tool: "render", arguments: {} }] },
    },
    {
      label: "missing dynamic tool arguments",
      turn: {
        items: [{ id: "tool-1", type: "dynamicToolCall", tool: "render", status: "completed" }],
      },
    },
    { label: "missing plan text", turn: { items: [{ id: "plan-1", type: "plan" }] } },
  ])("keeps the run open after a completion with $label", async ({ turn }) => {
    const harness = createStartedThreadHarness();
    const run = runCodexAppServerAttempt(createTestParams());
    await harness.waitForMethod("turn/start");

    await harness.notify({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", ...turn } },
    });
    await harness.notify(
      turnCompleted({
        id: "turn-1",
        status: "completed",
        items: [
          {
            id: "answer-1",
            type: "agentMessage",
            phase: "final_answer",
            text: "The native turn finished.",
          },
        ],
      }),
    );

    const result = await run;
    expect(result.terminal).toEqual({ kind: "ok" });
    expect(result.assistantTexts).toEqual(["The native turn finished."]);
  });
});

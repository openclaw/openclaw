import { expect, it } from "vitest";
import {
  captureAgent,
  makeCall,
  makeTool,
} from "../../../../packages/agent-core/src/agent-loop.test-support.js";
import { REPEATED_TOOL_ERROR_CODE } from "../../../../packages/agent-core/src/errors.js";
import { setInternalBeforeToolBatch } from "../../../../packages/agent-core/src/internal-hooks.js";
import { isRetryableAssistantError, isTerminalAssistantError } from "../../../llm/utils/retry.js";
import { buildEmbeddedRunPayloads } from "./payloads.js";
import { createToolLoopBatchAdmission } from "./tool-loop-recovery.js";

it.each(["probe", "private\n" + "x".repeat(300)])(
  "renders one bounded class-only terminal diagnostic for %j",
  async (name) => {
    const { agent, requests } = captureAgent(
      [
        {
          ...makeTool(name),
          execute: async () => {
            throw new Error("HTTP 503 request timed out: secret=synthetic-private-value");
          },
        },
      ],
      {},
      Array.from({ length: 4 }, (_, i) => [makeCall(name, String(i))]),
    );
    setInternalBeforeToolBatch(agent, createToolLoopBatchAdmission({}));
    await agent.prompt("start");
    expect(requests).toHaveLength(4);
    const terminal = agent.state.messages.at(-1);
    if (terminal?.role !== "assistant") {
      throw new Error("missing terminal assistant");
    }
    expect(terminal.errorCode).toBe(REPEATED_TOOL_ERROR_CODE);
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [],
      lastAssistant: terminal,
      sessionKey: "test:repeated-tool-error",
      verboseLevel: "full",
      rateLimitRetriesExhausted: 5,
      lastToolError: {
        toolName: name,
        error: "private raw tool failure",
        meta: "private command",
        mutatingAction: true,
      },
    });
    const label = name === "probe" ? "probe" : "tool";
    expect(payloads).toEqual([
      {
        text:
          "OpenClaw stopped this turn: the same " +
          label +
          " call failed 3 times (tool error). Check the tool inputs or service, then use a changed request.",
        isError: true,
      },
    ]);
    expect(JSON.stringify(payloads)).not.toContain("private");
    expect(payloads[0]?.text?.length).toBeLessThanOrEqual(240);
    for (const errorMessage of [
      terminal.errorMessage,
      "HTTP 503 request timed out",
      "OAuth token refresh failed",
    ]) {
      const diagnostic = { ...terminal, errorMessage };
      expect(isTerminalAssistantError(diagnostic)).toBe(true);
      expect(isRetryableAssistantError(diagnostic)).toBe(false);
      if (errorMessage !== terminal.errorMessage) {
        expect(
          buildEmbeddedRunPayloads({
            assistantTexts: [],
            lastAssistant: diagnostic,
            sessionKey: "test:repeated-tool-error",
            rateLimitRetriesExhausted: 5,
          }),
        ).toEqual([
          {
            text: "OpenClaw stopped this turn after 3 consecutive identical tool failures. Check the tool inputs or service, then use a changed request.",
            isError: true,
          },
        ]);
      }
    }
  },
);

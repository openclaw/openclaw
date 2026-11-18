import { describe, expect, it } from "vitest";
import {
  captureAgent,
  makeCall,
  makeTool,
} from "../../packages/agent-core/src/agent-loop.test-support.js";
import { TOOL_REPEAT_LIMIT_CODE } from "../../packages/agent-core/src/tool-repeat-guard.js";
import { buildExecForegroundResult } from "./bash-tools.exec-support.js";

describe("exec outcomes in stable tool rotations", () => {
  it.each(["metadata", "output", "hook"] as const)(
    "distinguishes runtime metadata from real progress: %s",
    async (kind) => {
      let executed = 0;
      const names = ["exec", "read", "write"];
      const tools = names.map((name) => ({
        ...makeTool(name),
        execute: async () => {
          executed += 1;
          return name === "exec"
            ? buildExecForegroundResult({
                outcome: {
                  status: "completed",
                  exitCode: 1,
                  exitSignal: null,
                  timedOut: false,
                  durationMs: executed,
                  aggregated: `error: missing dependency; pid=${executed}; attempt=${executed}; elapsed=${executed}ms${kind === "output" ? `; remaining=${executed}` : ""}`,
                },
              })
            : { content: [{ type: "text" as const, text: name }], details: {} };
        },
      }));
      const { agent } = captureAgent(
        tools,
        {
          afterToolCall:
            kind === "hook"
              ? async () => ({
                  content: [{ type: "text", text: `new visible progress ${executed}` }],
                })
              : undefined,
        },
        [
          ...Array.from({ length: 60 }, (_, index) => [
            makeCall(names[index % 3]!, `call-${index}`),
          ]),
          [{ type: "text", text: "done" }],
        ],
      );

      await agent.prompt("Complete the workflow.");

      expect(executed).toBe(kind === "metadata" ? 30 : 60);
      expect(agent.state.messages.at(-1)).toMatchObject(
        kind === "metadata"
          ? {
              role: "assistant",
              stopReason: "error",
              errorCode: TOOL_REPEAT_LIMIT_CODE,
            }
          : { role: "assistant", stopReason: "stop" },
      );
    },
  );
});

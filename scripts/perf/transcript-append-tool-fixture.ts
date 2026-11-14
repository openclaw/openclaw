import {
  captureCodeModeOutput,
  captureCodeModeValue,
  CodeModeOutputState,
} from "../../src/agents/code-mode-json.js";
import { projectMcpCallToolResult } from "../../src/agents/mcp-content.js";
import { formatToolSearchControlResult } from "../../src/agents/tool-search-runtime.js";
import { snapshotToolSearchTargetTranscriptResult } from "../../src/agents/tool-search-transcript.js";
import { failText, jsonResult } from "../../src/agents/tools/tool-results.js";
import type { Message } from "../../src/llm/types.js";

/** Synthetic control results and their raw/direct siblings, through real producers. */
export function toolAppendFixture(index: number, payloadBytes: number): Message {
  const text = `Synthetic output ${index}: `.padEnd(payloadBytes, "x");
  const records = Array.from({ length: 16 }, (_, row) => ({
    row,
    result: { items: [{ label: text.slice(0, 80), score: row / 16 }] },
  }));
  const kind = index % 6;
  let toolName: string;
  let result;
  switch (kind) {
    case 0:
      toolName = "read";
      result = jsonResult({ records, missing: undefined });
      break;
    case 1: {
      toolName = "exec";
      const output = new CodeModeOutputState(65_536);
      const nested = snapshotToolSearchTargetTranscriptResult(jsonResult({ records }));
      output.append(captureCodeModeOutput([nested.details], 65_536));
      result = formatToolSearchControlResult(
        output.takeResult(
          { status: "completed" },
          {
            value: captureCodeModeValue({ count: records.length }, 65_536),
          },
        ),
        undefined,
      );
      break;
    }
    case 2:
      toolName = "tool_search";
      result = formatToolSearchControlResult(
        records.map(({ row }) => ({
          id: `synthetic:tool-${row}`,
          name: `synthetic_${row}`,
          source: "plugin",
          input: { type: "object", properties: { query: { type: "string" } } },
        })),
        undefined,
      );
      break;
    case 3:
    case 4: {
      toolName = "dispatch_action";
      const target = snapshotToolSearchTargetTranscriptResult(
        kind === 3
          ? {
              content: [{ type: "text", text: text.slice(0, 1024) }],
              details: { records, date: new Date(0) },
            }
          : projectMcpCallToolResult({
              content: [{ type: "text", text: text.slice(0, 1024) }],
              structuredContent: { records },
            }),
      );
      const tool = {
        id: "synthetic:target",
        name: "target",
        source: kind === 3 ? "plugin" : "mcp",
      };
      // dispatch_action renders target content and retains the complete snapshot in details.
      result = {
        ...formatToolSearchControlResult({ tool, result: { content: target.content } }, undefined),
        details: { tool, result: target },
      };
      break;
    }
    default:
      toolName = "exec";
      result = failText(`Synthetic contract failure ${index}`);
  }
  return {
    role: "toolResult",
    toolCallId: `synthetic-call-${index}`,
    toolName,
    content: result.content,
    details: result.details,
    isError: kind === 5,
    timestamp: index,
  };
}

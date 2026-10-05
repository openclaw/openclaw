import { afterEach, expect, it } from "vitest";
import { buildPreparedCliRunContext } from "../cli-runner.test-helpers.js";
import { executePreparedCliRun as executePreparedCliRunImpl } from "./execute.js";
import {
  createManagedRun,
  createSuccessfulProcessExit,
  supervisorSpawnMock,
  wrapPreparedCliRunWithTestAdmission,
} from "./execute.test-support.js";

const executePreparedCliRun = wrapPreparedCliRunWithTestAdmission(executePreparedCliRunImpl);

afterEach(() => {
  supervisorSpawnMock.mockReset();
});

function streamEvent(event: Record<string, unknown>) {
  return `${JSON.stringify({ type: "stream_event", event })}\n`;
}

it("hands commentary to history after the backend output replacements", async () => {
  const chunks = [
    streamEvent({ type: "message_start", message: { id: "message-1" } }),
    streamEvent({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "Ask OldName." },
    }),
    streamEvent({
      type: "content_block_start",
      content_block: { type: "tool_use", id: "tool-1", name: "Read" },
    }),
    streamEvent({ type: "message_stop" }),
    streamEvent({ type: "message_start", message: { id: "message-2" } }),
    streamEvent({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "OldName done." },
    }),
    streamEvent({ type: "message_stop" }),
    `${JSON.stringify({ type: "result", subtype: "success", result: "OldName done." })}\n`,
  ];
  supervisorSpawnMock.mockImplementationOnce(async (input) => {
    for (const chunk of chunks) {
      input.onStdout?.(chunk);
    }
    return createManagedRun(createSuccessfulProcessExit());
  });
  const context = buildPreparedCliRunContext({
    backend: { command: "/bin/sh", args: [], jsonlDialect: "claude-stream-json" },
  });
  context.backendResolved.textTransforms = { output: [{ from: "OldName", to: "NewName" }] };
  context.params.emitCommentaryText = true;
  const segments: unknown[] = [];
  const result = await executePreparedCliRun(context, undefined, {
    onCommentarySegment: (segment) => segments.push(segment),
  });
  expect(segments).toMatchObject([{ key: "message-1:0", text: "Ask NewName." }]);
  expect(result.text).toBe("NewName done.");
});

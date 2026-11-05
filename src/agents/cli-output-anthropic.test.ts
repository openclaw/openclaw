import { expect, it, vi } from "vitest";
import { onAgentEvent } from "../infra/agent-events.js";
import type { CliBackendPlugin } from "../plugins/cli-backend.types.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";
import { createCliEventHandlers } from "./cli-runner/execute-events.js";
import {
  buildContext,
  buildToolTracking,
} from "./cli-runner/execute-events.tool-result-args.test-support.js";

async function loadClaudeBackend() {
  const { buildAnthropicCliBackend } = await loadBundledPluginFacade<{
    buildAnthropicCliBackend: () => CliBackendPlugin;
  }>({ pluginId: "anthropic", artifactBasename: "api.js" });
  return buildAnthropicCliBackend();
}

it("publishes one start and one completion per Claude automatic compaction", async () => {
  const backend = await loadClaudeBackend();
  const runId = "claude-auto-compaction-once";
  const handlers = createCliEventHandlers({
    context: buildContext(runId),
    toolTracking: buildToolTracking(),
    getRunState: () => ({ failed: false, error: undefined }),
  });
  const parser = createCliJsonlStreamingParser({
    backend: backend.config,
    providerId: backend.id,
    parseJsonlLifecycleEvent: backend.parseJsonlLifecycleEvent,
    onAssistantDelta: () => {},
    onCompaction: handlers.emitCliCompaction,
  });
  const phases: unknown[] = [];
  const dispose = onAgentEvent((event) => {
    if (event.runId === runId && event.stream === "compaction") {
      phases.push(event.data.phase);
    }
  });
  const status = { type: "system", subtype: "status", session_id: "session" };
  const boundary = {
    type: "system",
    subtype: "compact_boundary",
    session_id: "session",
    compact_metadata: { trigger: "auto", pre_tokens: 26_606 },
  };
  try {
    parser.push(
      [
        // Boundary-only automatic compactions each still complete.
        boundary,
        boundary,
        // Claude Code 2.1.318 resends `compacting` every 30 s during one compaction,
        // then closes it with both a success status and an automatic boundary.
        { ...status, status: "compacting" },
        { ...status, status: "compacting" },
        { ...status, status: "compacting" },
        { ...status, status: null, compact_result: "success" },
        boundary,
        // A back-to-back compaction after a finished one still notifies.
        { ...status, status: "compacting" },
        { ...status, status: "compacting" },
        { ...status, status: null, compact_result: "success" },
        boundary,
        boundary,
        { ...status, status: "compacting" },
        { ...status, status: "compacting" },
        { ...status, status: null, compact_result: "failed" },
        boundary,
        { type: "result", subtype: "success", result: "done", session_id: "session" },
      ]
        .map((frame) => JSON.stringify(frame))
        .join("\n"),
    );
    parser.finish();
  } finally {
    dispose();
  }

  // One start and one end per compaction; boundary-only compactions add an end each.
  expect(phases).toEqual([
    "end",
    "end",
    "start",
    "end",
    "start",
    "end",
    "end",
    "start",
    "end",
    "end",
  ]);
  expect(handlers.hasActiveCompaction()).toBe(false);
});

it("reports automatic Claude compaction without a status record or duplicate manual completion", async () => {
  const backend = await loadClaudeBackend();
  const onCompaction = vi.fn();
  const parser = createCliJsonlStreamingParser({
    backend: backend.config,
    providerId: backend.id,
    parseJsonlLifecycleEvent: backend.parseJsonlLifecycleEvent,
    onAssistantDelta: () => {},
    onCompaction,
  });
  const boundary = { type: "system", subtype: "compact_boundary", session_id: "session" };
  const frames = [
    { ...boundary, compact_metadata: { trigger: "auto", pre_tokens: 180_000 } },
    { type: "system", subtype: "status", status: "compacting" },
    { ...boundary, compact_metadata: { trigger: "manual", pre_tokens: 180_000 } },
    { compact_result: "success" },
    boundary,
    { ...boundary, compact_metadata: { trigger: "unknown" } },
    { type: "assistant", compact_metadata: { trigger: "auto" } },
    { type: "result", subtype: "success", result: "continued after compaction" },
  ];
  const stream = frames.map((frame) => JSON.stringify(frame)).join("\n");
  // Process output can split a native boundary across chunks and leave the final line unterminated.
  parser.push(stream.slice(0, 40));
  parser.push(stream.slice(40));
  parser.finish();

  expect(onCompaction.mock.calls).toEqual([
    [{ phase: "end", completed: true }],
    [{ phase: "start" }],
    [{ phase: "end", completed: true }],
  ]);
  expect(parser.getOutput()).toMatchObject({
    text: "continued after compaction",
    sessionId: "session",
  });
});

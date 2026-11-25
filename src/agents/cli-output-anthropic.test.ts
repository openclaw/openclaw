import { expect, it } from "vitest";
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
        // then closes it with a success status followed by its boundary.
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
  // Each published completion is counted once; the failed compaction is not.
  expect(handlers.getNativeCompaction()).toEqual({
    compactionCount: 6,
    compactionTokensBefore: 26_606,
  });
});

it("ends each Claude compaction at its boundary and counts it with the reported sizes", async () => {
  const backend = await loadClaudeBackend();
  const runId = "claude-compaction-sizes";
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
  const ends: unknown[] = [];
  const dispose = onAgentEvent((event) => {
    if (event.runId === runId && event.stream === "compaction" && event.data.phase === "end") {
      ends.push(event.data);
    }
  });
  const status = { type: "system", subtype: "status", session_id: "session" };
  const boundary = (trigger: string, pre_tokens: number, post_tokens: number) => ({
    type: "system",
    subtype: "compact_boundary",
    session_id: "session",
    compact_metadata: { trigger, pre_tokens, post_tokens, duration_ms: 8_725 },
  });
  // Claude Code 2.1.322 stream-json for one automatic and one manual compaction.
  const stream = [
    { ...status, status: "compacting" },
    { ...status, status: null, compact_result: "success" },
    boundary("auto", 64_743, 9_874),
    { ...status, status: "compacting" },
    { ...status, status: null, compact_result: "success" },
    boundary("manual", 33_905, 6_173),
    { type: "result", subtype: "success", result: "continued after compaction" },
  ]
    .map((frame) => JSON.stringify(frame))
    .join("\n");
  try {
    // Process output can split a native boundary across chunks and leave the final line unterminated.
    parser.push(stream.slice(0, 40));
    parser.push(stream.slice(40));
    parser.finish();
  } finally {
    dispose();
  }

  expect(ends).toMatchObject([
    { completed: true, trigger: "auto", tokensBefore: 64_743, tokensAfter: 9_874 },
    { completed: true, trigger: "manual", tokensBefore: 33_905, tokensAfter: 6_173 },
  ]);
  expect(handlers.getNativeCompaction()).toEqual({
    compactionCount: 2,
    compactionTokensBefore: 33_905,
    compactionTokensAfter: 6_173,
  });
  expect(parser.getOutput()).toMatchObject({
    text: "continued after compaction",
    sessionId: "session",
  });
});

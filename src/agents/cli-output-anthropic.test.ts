import { expect, it, vi } from "vitest";
import type { CliBackendPlugin } from "../plugins/cli-backend.types.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";

it("reports automatic Claude compaction without a status record or duplicate manual completion", async () => {
  const { buildAnthropicCliBackend } = await loadBundledPluginFacade<{
    buildAnthropicCliBackend: () => CliBackendPlugin;
  }>({ pluginId: "anthropic", artifactBasename: "api.js" });
  const backend = buildAnthropicCliBackend();
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

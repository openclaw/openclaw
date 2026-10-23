import { describe, expect, it, vi } from "vitest";
import { onAgentEvent } from "../../infra/agent-events.js";
import { createCliEventHandlers } from "./execute-events.js";
import { buildContext, buildToolTracking } from "./execute-events.tool-result-args.test-support.js";

describe("cli native compaction tracking", () => {
  it.each([true, false])(
    "tracks native compaction as active only between start and end (completed=%s)",
    (completed) => {
      const handlers = createCliEventHandlers({
        context: buildContext("run-compaction-active"),
        toolTracking: buildToolTracking(),
        getRunState: () => ({ failed: false, error: undefined }),
      });

      expect(handlers.hasActiveCompaction()).toBe(false);

      handlers.emitCliCompaction({ phase: "start" });
      expect(handlers.hasActiveCompaction()).toBe(true);

      handlers.emitCliCompaction({ phase: "end", completed });
      expect(handlers.hasActiveCompaction()).toBe(false);
    },
  );

  it("forwards the boundary's sizes without touching the active flag", () => {
    const runId = "run-compaction-boundary";
    const handlers = createCliEventHandlers({
      context: buildContext(runId),
      toolTracking: buildToolTracking(),
      getRunState: () => ({ failed: false, error: undefined }),
    });
    const onChange = vi.fn();
    handlers.setOnCompactionActiveChange(onChange);
    const events: Array<Record<string, unknown>> = [];
    const dispose = onAgentEvent((event) => {
      if (event.runId === runId && event.stream === "compaction") {
        events.push(event.data);
      }
    });
    try {
      handlers.emitCliCompaction({ phase: "start" });
      handlers.emitCliCompaction({ phase: "end", completed: true });
      onChange.mockClear();
      handlers.emitCliCompaction({
        phase: "boundary",
        trigger: "auto",
        tokensBefore: 473068,
        tokensAfter: 17604,
      });

      expect(handlers.hasActiveCompaction()).toBe(false);
      expect(onChange).not.toHaveBeenCalled();
      expect(events.at(-1)).toMatchObject({
        phase: "boundary",
        trigger: "auto",
        tokensBefore: 473068,
        tokensAfter: 17604,
      });
    } finally {
      dispose();
    }
  });
});

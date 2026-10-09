import { describe, expect, it } from "vitest";
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
});

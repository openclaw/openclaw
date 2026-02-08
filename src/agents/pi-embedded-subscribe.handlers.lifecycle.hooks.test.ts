import { describe, expect, it, vi } from "vitest";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  handleAutoCompactionEnd,
  handleAutoCompactionStart,
} from "./pi-embedded-subscribe.handlers.lifecycle.js";

vi.mock("../plugins/hook-runner-global.js");

const mockGetGlobalHookRunner = vi.mocked(getGlobalHookRunner);

describe("embedded subscribe lifecycle hook wiring", () => {
  it("fires before_compaction and after_compaction around compaction events", () => {
    const runBeforeCompaction = vi.fn().mockResolvedValue(undefined);
    const runAfterCompaction = vi.fn().mockResolvedValue(undefined);
    mockGetGlobalHookRunner.mockReturnValue({
      hasHooks: (name: string) => name === "before_compaction" || name === "after_compaction",
      runBeforeCompaction,
      runAfterCompaction,
    } as never);

    const ctx = {
      params: {
        runId: "r1",
        session: { messages: [{ role: "user" }, { role: "assistant" }, { role: "user" }] },
      },
      state: {
        compactionInFlight: false,
        compactionStartMessageCount: undefined,
      },
      log: { debug: vi.fn(), warn: vi.fn() },
      incrementCompactionCount: vi.fn(),
      ensureCompactionPromise: vi.fn(),
      noteCompactionRetry: vi.fn(),
      resetForCompactionRetry: vi.fn(),
      maybeResolveCompactionWait: vi.fn(),
      paramsOnAgentEvent: vi.fn(),
    } as unknown as Parameters<typeof handleAutoCompactionStart>[0];

    handleAutoCompactionStart(ctx);
    ctx.params.session.messages = [{ role: "user" }];
    handleAutoCompactionEnd(ctx, { type: "auto_compaction_end", willRetry: false });

    expect(runBeforeCompaction).toHaveBeenCalledWith({ messageCount: 3 }, {});
    expect(runAfterCompaction).toHaveBeenCalledWith({ messageCount: 1, compactedCount: 2 }, {});
  });
});

import { describe, expect, it, vi } from "vitest";
import type { Context, Model, StreamFn } from "../../../llm/types.js";
import {
  buildEmbeddedModelRequestRunContext,
  wrapStreamFnWithModelRequestRunContext,
} from "./attempt.model-run-context.js";

function createFakeStream() {
  return {
    async result() {
      return undefined as never;
    },
    [Symbol.asyncIterator]() {
      return (async function* () {})();
    },
  };
}

describe("embedded model request run context", () => {
  it("builds run context from embedded run params", () => {
    expect(
      buildEmbeddedModelRequestRunContext({
        runId: "run_123",
        messageProvider: "slack",
        bootstrapContextRunKind: "cron",
      }),
    ).toEqual({
      runId: "run_123",
      messageChannel: "slack",
      runKind: "cron",
    });

    expect(
      buildEmbeddedModelRequestRunContext({
        runId: "run_456",
        messageChannel: "telegram",
        trigger: "heartbeat",
      }),
    ).toEqual({
      runId: "run_456",
      messageChannel: "telegram",
      runKind: "heartbeat",
    });
  });

  it("adds run context to model stream calls without mutating the original context", async () => {
    const baseStreamFnMock = vi.fn(() => createFakeStream());
    const baseStreamFn = baseStreamFnMock as unknown as StreamFn;
    const wrappedStreamFn = wrapStreamFnWithModelRequestRunContext(baseStreamFn, {
      runId: "run_123",
      messageChannel: "slack",
      runKind: "message",
    });
    const context: Context = {
      messages: [],
      runContext: {
        runId: "stale-run",
      },
    };

    await wrappedStreamFn({} as Model, context);

    expect(context.runContext).toEqual({ runId: "stale-run" });
    expect(baseStreamFnMock.mock.calls[0]?.[1]).toEqual({
      messages: [],
      runContext: {
        runId: "run_123",
        messageChannel: "slack",
        runKind: "message",
      },
    });
  });
});

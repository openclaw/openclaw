import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";

const streamSignalEvents = vi.hoisted(() => vi.fn());

vi.mock("./client-adapter.js", () => ({ streamSignalEvents }));

import { runSignalSseLoop } from "./sse-reconnect.js";

describe("runSignalSseLoop lifecycle", () => {
  beforeEach(() => {
    streamSignalEvents.mockReset();
  });

  it("publishes ready on stream open and recovering when the stream ends", async () => {
    const abort = new AbortController();
    const statusSink = vi.fn((patch: { lifecycle?: string }) => {
      if (patch.lifecycle === "recovering") {
        abort.abort();
      }
    });
    streamSignalEvents.mockImplementationOnce(async (params) => {
      params.onStreamOpen?.();
    });

    await runSignalSseLoop({
      baseUrl: "http://signal.test",
      abortSignal: abort.signal,
      runtime: createRuntimeSpies(),
      onEvent: vi.fn(),
      statusSink,
    });

    expect(statusSink).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ lifecycle: "ready", connected: true }),
    );
    expect(statusSink).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ lifecycle: "recovering", connected: false }),
    );
  });

  it("publishes recovering for stream errors", async () => {
    const abort = new AbortController();
    const statusSink = vi.fn((patch: { lifecycle?: string }) => {
      if (patch.lifecycle === "recovering") {
        abort.abort();
      }
    });
    streamSignalEvents.mockRejectedValueOnce(new Error("stream failed"));

    await runSignalSseLoop({
      baseUrl: "http://signal.test",
      abortSignal: abort.signal,
      runtime: createRuntimeSpies(),
      onEvent: vi.fn(),
      statusSink,
    });

    expect(statusSink).toHaveBeenCalledWith(
      expect.objectContaining({ lifecycle: "recovering", lastError: "Error: stream failed" }),
    );
  });
});

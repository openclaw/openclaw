import { withServer } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { runSignalSseLoop, type SignalStatusSink } from "./sse-reconnect.js";

it.each([
  {
    status: 400,
    message: "Account Selection Required",
    requests: 1,
    patches: [
      {
        lifecycle: "blocked",
        terminalDisconnect: true,
        connected: false,
        lastError:
          "Signal daemon rejected the event stream: Signal SSE failed (400 Account Selection Required). Check the configured account and daemon URL, fix the daemon or proxy response, then restart the channel.",
      },
    ],
  },
  {
    status: 503,
    message: "Try Again Later",
    requests: 2,
    patches: [
      expect.objectContaining({ lifecycle: "recovering", connected: false }),
      expect.objectContaining({ lifecycle: "recovering", connected: false }),
    ],
  },
])("publishes the native HTTP $status lifecycle and makes $requests requests", async (expected) => {
  const abort = new AbortController();
  let requests = 0;
  const statusSink = vi.fn<SignalStatusSink>(() => {
    if (expected.status === 503 && requests === 2) {
      abort.abort();
    }
  });
  await withServer(
    (_request, response) => {
      requests += 1;
      if (expected.status === 400 && requests === 2) {
        abort.abort();
      }
      response.statusMessage = expected.message;
      response.writeHead(expected.status, { "content-type": "text/plain" });
      response.end("rejected\n");
    },
    async (baseUrl) => {
      await runSignalSseLoop({
        baseUrl,
        account: "+15555550100",
        abortSignal: abort.signal,
        runtime: createRuntimeSpies(),
        onEvent: vi.fn(),
        statusSink,
        policy:
          expected.status === 503 ? { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 } : undefined,
      });
      expect(requests).toBe(expected.requests);
      const patches = statusSink.mock.calls.map(([patch]) => patch);
      expect(patches).toEqual(expected.patches);
      if (expected.status === 503) {
        expect(patches).not.toContainEqual(expect.objectContaining({ terminalDisconnect: true }));
      }
    },
  );
});

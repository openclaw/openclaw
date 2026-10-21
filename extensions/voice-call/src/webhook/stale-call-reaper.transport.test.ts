import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { withFetchPreconnect, withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { endCall } from "../manager/outbound.js";
import { TelnyxProvider } from "../providers/telnyx.js";
import { makeCall } from "./realtime-call-control.test-helpers.js";
import { startStaleCallReaper } from "./stale-call-reaper.js";

async function waitForProofEvent<T>(promise: Promise<T>, label: string): Promise<T> {
  // AbortSignal.timeout stays real while this suite fakes the global timer functions.
  const timeoutSignal = AbortSignal.timeout(1_000);
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error(`timed out waiting for ${label}`));
    timeoutSignal.addEventListener("abort", onAbort, { once: true });
    void promise
      .then(resolve, reject)
      .finally(() => timeoutSignal.removeEventListener("abort", onAbort));
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("keeps one Telnyx hangup in flight, then retries after the provider timeout", async () => {
  vi.useFakeTimers({
    // Voice provider requests use buildTimeoutAbortSignal's setTimeout timer.
    toFake: ["performance", "Date", "setInterval", "clearInterval", "setTimeout", "clearTimeout"],
  });
  vi.setSystemTime(new Date("2026-07-15T12:00:00.000Z"));

  const firstRequestStarted = createDeferred<void>();
  const firstResponseClosed = createDeferred<void>();
  const secondRequestStarted = createDeferred<void>();
  let requestCount = 0;

  await withServer(
    (_req, res) => {
      requestCount += 1;
      if (requestCount === 1) {
        res.once("close", () => firstResponseClosed.resolve());
        firstRequestStarted.resolve();
        return;
      }
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("controlled provider failure");
      secondRequestStarted.resolve();
    },
    async (baseUrl) => {
      const realFetch = globalThis.fetch.bind(globalThis);
      const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const providerUrl = new URL(input instanceof Request ? input.url : String(input));
        const loopbackUrl = new URL(`${providerUrl.pathname}${providerUrl.search}`, baseUrl);
        return await realFetch(loopbackUrl, init);
      });
      vi.stubGlobal("fetch", withFetchPreconnect(transport));

      const provider = new TelnyxProvider({
        apiKey: "KEY123",
        connectionId: "connection-test",
      });
      const call = makeCall("provider-stale", {
        callId: "call-stale",
        provider: "telnyx",
        startedAt: Date.now() - 61_000,
        state: "active" as const,
      });
      const context: Parameters<typeof endCall>[0] = {
        mutationQueue: new KeyedAsyncQueue(),
        activeCalls: new Map([[call.callId, call]]),
        providerCallIdMap: new Map([["provider-stale", call.callId]]),
        provider,
        storePath: "/tmp/openclaw-voice-call-proof.json",
        transcriptWaiters: new Map(),
        maxDurationTimers: new Map(),
        notifyHangupTimers: new Map(),
        endCallOperations: new Map(),
      };
      const manager = {
        getActiveCalls: () => [...context.activeCalls.values()],
        endCall: vi.fn((callId: string) => endCall(context, callId)),
      };

      const stop = startStaleCallReaper({
        scheduler: createTestPluginServiceScheduler(),
        manager,
        staleCallReaperSeconds: 60,
      });

      await vi.advanceTimersByTimeAsync(30_000);
      await waitForProofEvent(firstRequestStarted.promise, "the first provider request");
      expect(requestCount).toBe(1);
      const firstOperation = manager.endCall.mock.results[0]?.value;
      expect(firstOperation).toBeDefined();
      expect(endCall(context, call.callId)).toBe(firstOperation);

      // The next sweep coincides with the provider's 30s request timeout. It must
      // not start another hangup before the first attempt has settled.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(requestCount).toBe(1);
      expect(manager.endCall).toHaveBeenCalledTimes(1);

      await expect(
        waitForProofEvent(firstOperation!, "the first endCall settlement"),
      ).resolves.toEqual({ success: false, error: "request timed out" });
      await waitForProofEvent(firstResponseClosed.promise, "the timed-out socket close");
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(30_000);
      await waitForProofEvent(secondRequestStarted.promise, "the retried provider request");
      const retryOperation = manager.endCall.mock.results[1]?.value;
      expect(retryOperation).toBeDefined();
      await expect(
        waitForProofEvent(retryOperation!, "the retried endCall settlement"),
      ).resolves.toEqual({
        success: false,
        error: "Telnyx API error: 503 controlled provider failure",
      });
      expect(requestCount).toBe(2);
      expect(manager.endCall).toHaveBeenCalledTimes(2);
      expect(transport).toHaveBeenCalledTimes(2);

      await stop?.();
    },
  );
});

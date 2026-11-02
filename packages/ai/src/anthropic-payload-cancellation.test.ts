import { describe, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import { configureAiTransportHost, getAiTransportHost } from "./host.js";
import {
  anthropicEvents,
  anthropicModel,
  context,
  createAnthropicResponse,
  registerParityHostLifecycle,
} from "./provider-transport-parity.test-support.js";
import { streamAnthropic } from "./providers/anthropic.js";
import { createAnthropicMessagesTransportStreamFn } from "./transports/anthropic-transport-stream.js";

registerParityHostLifecycle();

describe.each([
  { route: "SDK", late: "resolve" },
  { route: "fetch", late: "reject" },
] as const)("$route payload hook's late $late", ({ route, late }) => {
  it("settles cancellation while retaining the unfinished hook", async ({ signal }) => {
    const controller = new AbortController();
    const entered = createDeferred();
    const hook = createDeferred();
    const observed: Promise<unknown>[] = [];
    let hookFinished = false;
    const fetch = vi.fn(async () => createAnthropicResponse(anthropicEvents));
    configureAiTransportHost({
      ...getAiTransportHost(),
      buildModelFetch: () => fetch,
      observePendingProviderWork: (pending) => observed.push(pending),
    });
    const options = {
      apiKey: "synthetic-request-key",
      signal: controller.signal,
      onPayload: async () => {
        entered.resolve();
        try {
          await hook.promise;
        } finally {
          hookFinished = true;
        }
      },
    };
    const stream = await (route === "SDK"
      ? streamAnthropic(anthropicModel, context, options)
      : createAnthropicMessagesTransportStreamFn()(anthropicModel, context, options));
    try {
      await withinTest(entered.promise, signal);
      controller.abort(Object.assign(new Error("payload cancelled"), { code: "caller_cancelled" }));
      const result = await withinTest(stream.result(), signal);
      expect(result).toMatchObject({ stopReason: "aborted", errorCode: "caller_cancelled" });
      expect(hookFinished).toBe(false);
      expect(observed).not.toHaveLength(0);
      expect(fetch).not.toHaveBeenCalled();

      if (late === "resolve") {
        hook.resolve();
      } else {
        hook.reject(new Error("late payload failure"));
      }
      await Promise.allSettled(observed);
      expect(hookFinished).toBe(true);
      expect(await stream.result()).toBe(result);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      hook.resolve();
      await Promise.allSettled([...observed, stream.result()]);
    }
  });
});

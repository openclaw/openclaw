import { describe, expect, it, vi } from "vitest";
import { attachIMessageMonitorAbortHandler } from "./monitor/abort-handler.js";
describe("monitorIMessageProvider", () => {
  it("does not trigger unhandledRejection when aborting during shutdown", async () => {
    const abortController = new AbortController();
    let subscriptionId = 1;
    const requestMock = vi.fn((method, _params) => {
      if (method === "watch.unsubscribe") {
        return Promise.reject(new Error("imsg rpc closed"));
      }
      return Promise.resolve({});
    });
    const stopMock = vi.fn(async () => {
    });
    const unhandled = [];
    const onUnhandled = (reason) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const detach = attachIMessageMonitorAbortHandler({
        abortSignal: abortController.signal,
        client: {
          request: requestMock,
          stop: stopMock
        },
        getSubscriptionId: () => subscriptionId
      });
      abortController.abort();
      await new Promise((resolve) => setImmediate(resolve));
      detach();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toHaveLength(0);
    expect(stopMock).toHaveBeenCalled();
    expect(requestMock).toHaveBeenCalledWith("watch.unsubscribe", { subscription: 1 });
  });
});

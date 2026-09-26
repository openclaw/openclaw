import { describe, expect, it } from "vitest";
import { GatewayPendingRequests } from "./pending-request.js";

describe("GatewayPendingRequests", () => {
  it("does not retain settled IDs for the socket generation", async () => {
    let requestId = 0;
    const requests = new GatewayPendingRequests({
      createRequestId: () => `request-${requestId++}`,
      nowMs: () => 0,
    });
    const sender = {
      send: () => {
        throw new Error("synthetic send failure");
      },
    };

    for (let index = 0; index < 100; index += 1) {
      await requests.request(sender, "bounded", {}, { timeoutMs: null }).catch(() => undefined);
    }

    const retained = (requests as unknown as { retiredIds?: ReadonlySet<string> }).retiredIds;
    expect(retained?.size ?? 0).toBe(0);
  });

  it("settles each retired request once when its timing observer shuts down again", async () => {
    const timings: string[] = [];
    const requests = new GatewayPendingRequests({
      createRequestId: () => "stable",
      nowMs: () => 0,
      onTiming: ({ method }) => {
        timings.push(method);
        if (timings.length === 1) {
          requests.flush(new Error("nested shutdown"));
        }
      },
    });
    const retired = requests.request(
      { send: () => {} },
      "session.observe",
      {},
      {
        timeoutMs: null,
      },
    );
    void retired.catch(() => undefined);

    requests.flush(new Error("transport closed"));

    expect(timings).toEqual(["session.observe"]);
    await expect(retired).rejects.toThrow("transport closed");
    expect(requests.hasPending).toBe(false);
  });
});

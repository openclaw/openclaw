import { describe, expect, it, vi } from "vitest";

describe("zca-client runtime loading", () => {
  it("does not import zca-js until a session is created", async () => {
    vi.clearAllMocks();
    let capturedOptions: { logging?: boolean; selfListen?: boolean } | undefined;
    const runtimeFactory = vi.fn(() => ({
      Zalo: class MockZalo {
        constructor(options?: { logging?: boolean; selfListen?: boolean }) {
          capturedOptions = options;
        }
      },
    }));

    vi.doMock("zca-js", runtimeFactory);

    const zcaClient = await import("./zca-client.js");
    expect(runtimeFactory).not.toHaveBeenCalled();

    await zcaClient.createZalo({ logging: false, selfListen: true });

    expect(runtimeFactory).toHaveBeenCalledTimes(1);
    expect(capturedOptions).toEqual({ logging: false, selfListen: true });
  });
});

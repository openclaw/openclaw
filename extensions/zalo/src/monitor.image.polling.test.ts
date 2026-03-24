import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeEnv } from "../../../test/helpers/extensions/runtime-env.js";
import {
  createImageLifecycleCore,
  createImageUpdate,
  createLifecycleMonitorSetup,
  expectImageLifecycleDelivery,
  getUpdatesMock,
  getZaloRuntimeMock,
  resetLifecycleTestState,
} from "../../../test/helpers/extensions/zalo-lifecycle.js";

describe("Zalo polling image handling", () => {
  const {
    core,
    finalizeInboundContextMock,
    recordInboundSessionMock,
    fetchRemoteMediaMock,
    saveMediaBufferMock,
  } = createImageLifecycleCore();

  beforeEach(() => {
    resetLifecycleTestState();
    getZaloRuntimeMock.mockReturnValue(core);
  });

  afterEach(() => {
    resetLifecycleTestState();
  });

  it("downloads inbound image media from photo_url and preserves display_name", async () => {
    getUpdatesMock
      .mockResolvedValueOnce({
        ok: true,
        result: createImageUpdate({ date: 1774084566880 }),
      })
      .mockImplementation(() => new Promise(() => {}));

    const { monitorZaloProvider } = await import("./monitor.js");
    const abort = new AbortController();
    const runtime = createRuntimeEnv();
    const { account, config } = createLifecycleMonitorSetup({
      accountId: "default",
      dmPolicy: "open",
    });
    const run = monitorZaloProvider({
      token: "zalo-token", // pragma: allowlist secret
      account,
      config,
      runtime,
      abortSignal: abort.signal,
    });

    await vi.waitFor(() => expect(fetchRemoteMediaMock).toHaveBeenCalledTimes(1));
    expectImageLifecycleDelivery({
      fetchRemoteMediaMock,
      saveMediaBufferMock,
      finalizeInboundContextMock,
      recordInboundSessionMock,
    });

    abort.abort();
    await run;
  });
});

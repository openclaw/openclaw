import { vi } from "vitest";
import * as client from "../client.js";

export async function createXReadinessFixture() {
  const apiSpy = vi.spyOn(client, "getXApi");
  const { config, fixture } = await import("./monitor-fixture.js");
  const test = fixture({
    posts: [],
    cfg: {
      ...config,
      channels: {
        x: { ...config.channels?.x, bearerToken: "test-bearer", events: { mode: "stream" } },
      },
    },
  });
  let stream: ReadableStreamDefaultController<Uint8Array>;
  test.api.openActivityStream.mockImplementation(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            stream = controller;
          },
        }),
      ),
  );
  const running = test.start();
  await vi.advanceTimersByTimeAsync(0);
  return {
    status: running.status,
    disconnect() {
      stream.close();
    },
    failReconnects() {
      test.api.openActivityStream.mockRejectedValue(new Error("stream unavailable"));
    },
    async stop() {
      try {
        await test.stop();
      } finally {
        apiSpy.mockRestore();
      }
    },
  };
}

import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { BedrockClient, GetInferenceProfileCommand } from "@aws-sdk/client-bedrock";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { runBedrockControlPlaneRequest } from "./control-plane.js";

describe("Bedrock control-plane transport", () => {
  it("does not send when the parent signal is already aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled before send");
    controller.abort(reason);
    const send = vi.fn(async () => "unexpected");

    await expect(
      runBedrockControlPlaneRequest({
        operation: "Bedrock pre-aborted request",
        signal: controller.signal,
        send,
      }),
    ).rejects.toBe(reason);
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a transport response that resolves after the deadline", async () => {
    vi.useFakeTimers();
    try {
      const response = createDeferred<string>();
      const request = runBedrockControlPlaneRequest({
        operation: "Bedrock late response",
        send: () => response.promise,
      });

      await vi.advanceTimersByTimeAsync(30_000);
      response.resolve("too late");

      await expect(request).rejects.toMatchObject({ name: "TimeoutError" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts and closes the real Smithy socket", async () => {
    const requestStarted = createDeferred<{
      path: string | undefined;
      socketClosed: Promise<void>;
    }>();
    const server = createServer((request) => {
      requestStarted.resolve({
        path: request.url,
        socketClosed: new Promise<void>((resolve) => {
          request.socket.once("close", () => {
            resolve();
          });
        }),
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    const client = new BedrockClient({
      region: "us-east-1",
      endpoint: `http://127.0.0.1:${address.port}`,
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
      maxAttempts: 1,
    });
    const controller = new AbortController();
    const reason = new Error("caller cancelled control-plane request");

    try {
      const response = runBedrockControlPlaneRequest({
        operation: "Bedrock GetInferenceProfile",
        signal: controller.signal,
        send: (options) =>
          client.send(
            new GetInferenceProfileCommand({ inferenceProfileIdentifier: "test-profile" }),
            options,
          ),
      });
      const request = await requestStarted.promise;
      expect(request.path).toBe("/inference-profiles/test-profile");

      controller.abort(reason);

      await expect(response).rejects.toMatchObject({ name: "AbortError", cause: reason });
      await request.socketClosed;
    } finally {
      client.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});

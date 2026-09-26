import http from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it, vi } from "vitest";
import { installMatrixTestRuntime } from "../../test-runtime.js";
import {
  createMatrixMonitorTaskRunner,
  getMatrixMonitorTaskSignal,
} from "../monitor/task-runner.js";
import { MatrixClient } from "../sdk.js";
import { backfillMatrixAuthDeviceIdAfterStartup, resolveMatrixAuth } from "./config.js";

vi.mock("../credentials-read.js", () => ({
  loadMatrixCredentialsAsync: async () => null,
  credentialsMatchConfig: () => false,
}));
vi.mock("../credentials.js", () => ({
  saveMatrixCredentials: async () => {},
}));

afterEach(() => vi.restoreAllMocks());

it("disposes the real identity client after token-only auth resolves whoami", async () => {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ user_id: "@fixture:example.org", device_id: "FIXTURE" }));
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  installMatrixTestRuntime({ logging: { getChildLogger: () => logger } });
  const stop = vi.spyOn(MatrixClient.prototype, "stopWithoutPersist");
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected loopback fixture address");
    }
    const auth = await resolveMatrixAuth({
      cfg: {
        channels: {
          matrix: {
            homeserver: `http://127.0.0.1:${address.port}`,
            accessToken: "synthetic-token",
            network: { dangerouslyAllowPrivateNetwork: true },
          },
        },
      },
      env: {},
    });
    expect(auth).toMatchObject({
      userId: "@fixture:example.org",
      deviceId: "FIXTURE",
      allowPrivateNetwork: true,
    });
    const identityClient = stop.mock.contexts[0];
    if (!(identityClient instanceof MatrixClient)) {
      throw new Error("Expected the disposed identity client");
    }
    await expect(
      identityClient.doRequest("GET", "/_matrix/client/v3/account/whoami"),
    ).rejects.toThrow("no longer active");
    expect(requests).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

it("cancels an in-flight SDK whoami request and joins backfill on monitor retirement", async () => {
  const received = createDeferred<void>();
  let requestClosed = false;
  const server = http.createServer((request, response) => {
    expect(request.url).toBe("/_matrix/client/v3/account/whoami");
    response.once("close", () => {
      requestClosed = true;
    });
    received.resolve();
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  installMatrixTestRuntime({ logging: { getChildLogger: () => logger } });
  const runner = createMatrixMonitorTaskRunner({ logger, logVerboseMessage: () => {} });
  let task: Promise<void> | undefined;
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected loopback fixture address");
    }
    task = runner.runDetachedTask("deviceId backfill", async () => {
      const result = await backfillMatrixAuthDeviceIdAfterStartup({
        auth: {
          homeserver: `http://127.0.0.1:${address.port}`,
          userId: "@fixture:example.org",
          accountId: "default",
          accessToken: "synthetic-token",
          ssrfPolicy: { allowPrivateNetwork: true },
        },
        abortSignal: getMatrixMonitorTaskSignal(),
      });
      expect(result).toBeUndefined();
    });
    await Promise.race([
      received.promise,
      task.then(() => {
        throw new Error("Backfill settled before reaching the loopback fixture");
      }),
    ]);
    runner.close();
    const retired = runner.waitForIdle();
    await expect.poll(() => requestClosed).toBe(true);
    await retired;
    expect(logger.warn).not.toHaveBeenCalled();
  } finally {
    runner.close();
    server.closeAllConnections();
    await task;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

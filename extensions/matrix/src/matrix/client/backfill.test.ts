import http from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getMatrixRuntime } from "../../runtime.js";
import { installMatrixTestRuntime } from "../../test-runtime.js";
import {
  createMatrixMonitorTaskRunner,
  getMatrixMonitorTaskSignal,
} from "../monitor/task-runner.js";
import { probeMatrix } from "../probe.js";
import { backfillMatrixAuthDeviceIdAfterStartup, resolveMatrixAuth } from "./config.js";

vi.mock("../credentials-read.js", () => ({
  loadMatrixCredentialsAsync: async () => null,
  credentialsMatchConfig: () => false,
}));
vi.mock("../credentials.js", () => ({
  saveMatrixCredentials: async () => {},
}));

const identity = { user_id: "@fixture:example.org", device_id: "FIXTURE" };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  installMatrixTestRuntime({ logging: { getChildLogger: () => logger } });
});
afterEach(() => vi.restoreAllMocks());

async function listen(server: http.Server) {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected loopback fixture address");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: http.Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

it("authenticates identity, login, and probe outcomes without opening probe state (#61317)", async () => {
  let requests = 0;
  let rejectLogin = false;
  const server = http.createServer((request, response) => {
    requests++;
    const login = request.url === "/_matrix/client/v3/login";
    const rejected = login ? rejectLogin : request.headers.authorization === "Bearer expired-token";
    response.writeHead(rejected ? 401 : 200, { "content-type": "application/json" });
    response.end(
      JSON.stringify(
        rejected
          ? { error: "Invalid credentials" }
          : { ...identity, ...(login ? { access_token: "synthetic-token" } : {}) },
      ),
    );
  });
  try {
    const homeserver = await listen(server);
    const matrix = { homeserver, network: { dangerouslyAllowPrivateNetwork: true } };
    await expect(
      resolveMatrixAuth({
        cfg: { channels: { matrix: { ...matrix, accessToken: "synthetic-token" } } },
        env: {},
      }),
    ).resolves.toMatchObject({
      userId: identity.user_id,
      deviceId: identity.device_id,
      allowPrivateNetwork: true,
    });
    const loginConfig = {
      channels: { matrix: { ...matrix, userId: identity.user_id, password: "synthetic-password" } },
    };
    await expect(resolveMatrixAuth({ cfg: loginConfig, env: {} })).resolves.toMatchObject({
      userId: "@fixture:example.org",
      accessToken: "synthetic-token",
    });
    rejectLogin = true;
    await expect(resolveMatrixAuth({ cfg: loginConfig, env: {} })).rejects.toMatchObject({
      statusCode: 401,
    });
    const state = getMatrixRuntime().state;
    const stateAccess = [
      vi.spyOn(state, "openKeyedStore"),
      vi.spyOn(state, "openKeyedStoreV2"),
      vi.spyOn(state, "openSyncKeyedStore"),
      vi.spyOn(state, "openBlobStore"),
    ];
    for (const outcome of ["success", "mismatch", "unauthorized"] as const) {
      const result = await probeMatrix({
        homeserver,
        accessToken: outcome === "unauthorized" ? "expired-token" : "synthetic-token",
        userId: outcome === "mismatch" ? "@other:example.org" : "@fixture:example.org",
        deviceId: "FIXTURE",
        accountId: "ops",
        allowPrivateNetwork: true,
      });
      expect(result.ok).toBe(outcome === "success");
      if (outcome === "unauthorized") {
        expect(result.status).toBe(401);
      }
      if (outcome === "mismatch") {
        expect(result.error).toContain("does not match configured userId");
      }
    }
    for (const open of stateAccess) {
      expect(open).not.toHaveBeenCalled();
    }
    expect(requests).toBe(6);
  } finally {
    await close(server);
  }
});

it("cancels an in-flight whoami request and joins backfill on monitor retirement", async () => {
  const received = createDeferred<void>();
  let requestClosed = false;
  const server = http.createServer((request, response) => {
    expect(request.url).toBe("/_matrix/client/v3/account/whoami");
    response.once("close", () => {
      requestClosed = true;
    });
    received.resolve();
  });
  const runner = createMatrixMonitorTaskRunner({ logger, logVerboseMessage: () => {} });
  let task: Promise<void> | undefined;
  try {
    const homeserver = await listen(server);
    task = runner.runDetachedTask("deviceId backfill", async () => {
      const result = await backfillMatrixAuthDeviceIdAfterStartup({
        auth: {
          homeserver,
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
    await close(server);
  }
});

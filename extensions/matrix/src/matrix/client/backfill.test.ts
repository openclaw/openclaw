import http from "node:http";
import { promisify } from "node:util";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
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
// mock-isolation: Loopback auth probes must not persist their synthetic credentials.
vi.mock("../credentials.js", () => ({ saveMatrixCredentials: async () => {} }));

const identity = { user_id: "@fixture:example.org", device_id: "FIXTURE" };
const token = "synthetic-token";
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  installMatrixTestRuntime({ logging: { getChildLogger: () => logger } });
});
afterEach(() => vi.restoreAllMocks());

async function listen(server: http.Server) {
  onTestFinished(async () => {
    server.closeAllConnections();
    await promisify(server.close.bind(server))();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected loopback fixture address");
  }
  return `http://127.0.0.1:${address.port}`;
}

it("authenticates identity, login, and probe outcomes without opening probe state (#61317)", async () => {
  let requests = 0;
  let rejectLogin = false;
  const server = http.createServer((request, response) => {
    requests++;
    const login = request.url === "/_matrix/client/v3/login";
    const rejected = login ? rejectLogin : request.headers.authorization === "Bearer expired-token";
    response.writeHead(rejected ? 401 : 200, { "content-type": "application/json" });
    const payload = { ...identity, access_token: login ? token : undefined };
    response.end(JSON.stringify(rejected ? { error: "Invalid credentials" } : payload));
  });
  const homeserver = await listen(server);
  const matrix = { homeserver, network: { dangerouslyAllowPrivateNetwork: true } };
  const authenticate = (auth: { accessToken?: string; userId?: string; password?: string }) =>
    resolveMatrixAuth({ cfg: { channels: { matrix: { ...matrix, ...auth } } }, env: {} });
  await expect(authenticate({ accessToken: token })).resolves.toMatchObject({
    userId: identity.user_id,
    deviceId: identity.device_id,
    allowPrivateNetwork: true,
  });
  const login = { userId: identity.user_id, password: "synthetic-password" };
  await expect(authenticate(login)).resolves.toMatchObject({
    userId: "@fixture:example.org",
    accessToken: token,
  });
  rejectLogin = true;
  await expect(authenticate(login)).rejects.toMatchObject({ statusCode: 401 });
  const stateAccess = (
    ["openKeyedStore", "openKeyedStoreV2", "openSyncKeyedStore", "openBlobStore"] as const
  ).map((method) => vi.spyOn(getMatrixRuntime().state, method));
  for (const [outcome, expected] of Object.entries({
    success: { ok: true },
    mismatch: { ok: false, error: expect.stringContaining("does not match configured userId") },
    unauthorized: { ok: false, status: 401 },
  })) {
    const result = await probeMatrix({
      homeserver,
      accessToken: outcome === "unauthorized" ? "expired-token" : token,
      userId: outcome === "mismatch" ? "@other:example.org" : "@fixture:example.org",
      allowPrivateNetwork: true,
    });
    expect(result).toMatchObject(expected);
  }
  for (const open of stateAccess) {
    expect(open).not.toHaveBeenCalled();
  }
  expect(requests).toBe(6);
});

it("cancels an in-flight whoami request and joins backfill on monitor retirement", async () => {
  const received = createDeferred<void>();
  const closed = createDeferred<void>();
  const server = http.createServer((request, response) => {
    expect(request.url).toBe("/_matrix/client/v3/account/whoami");
    response.once("close", closed.resolve);
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
          accessToken: token,
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
    await closed.promise;
    await retired;
    expect(logger.warn).not.toHaveBeenCalled();
  } finally {
    runner.close();
    server.closeAllConnections();
    await task;
  }
});

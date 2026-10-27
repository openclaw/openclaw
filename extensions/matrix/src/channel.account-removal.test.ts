import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { matrixPlugin } from "./channel.js";
import { matrixSetupPlugin } from "./channel.setup.js";
import { resolveMatrixAuth } from "./matrix/client/config.js";
import { loadMatrixCredentials, saveMatrixCredentials } from "./matrix/credentials.js";
import { installMatrixTestRuntime } from "./test-runtime.js";

const userId = "@bot:example.org";
let stateDir = "";

beforeEach(() => {
  resetPluginStateStoreForTests();
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-matrix-account-removal-"));
  // The removal hook reads process.env like the CLI, so point it at this test state.
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  installMatrixTestRuntime({ stateDir });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeOpenClawStateDatabaseAsync();
  resetPluginStateStoreForTests();
  fs.rmSync(stateDir, { recursive: true, force: true });
});

async function startHomeserver() {
  const requests: string[] = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({ user_id: userId, device_id: "NEWDEVICE", access_token: "fresh-token" }),
    );
  });
  onTestFinished(async () => {
    server.closeAllConnections();
    await promisify(server.close.bind(server))();
  });
  await new Promise<void>((listening) => {
    server.listen(0, "127.0.0.1", listening);
  });
  const { port } = server.address() as { port: number };
  return { homeserver: `http://127.0.0.1:${port}`, requests };
}

it.each([
  ["setup plugin (channels remove)", matrixSetupPlugin],
  ["runtime plugin", matrixPlugin],
] as const)(
  "forgets the cached login when the account is removed via the %s",
  async (_name, plugin) => {
    const { homeserver, requests } = await startHomeserver();
    const matrix = { homeserver, userId, network: { dangerouslyAllowPrivateNetwork: true } };
    await saveMatrixCredentials(
      { homeserver, userId, accessToken: "revoked-token", deviceId: "OLDDEVICE" },
      process.env,
      "default",
    );

    await plugin.lifecycle?.onAccountRemoved?.({
      prevCfg: { channels: { matrix } },
      accountId: "default",
      runtime: {} as never,
    });
    expect(loadMatrixCredentials(process.env, "default")).toBeNull();

    // Re-adding the same account id with a password must not resurrect the removed token.
    const auth = await resolveMatrixAuth({
      cfg: { channels: { matrix: { ...matrix, password: "synthetic-password" } } },
      env: process.env,
    });
    expect(auth).toMatchObject({ accessToken: "fresh-token", deviceId: "NEWDEVICE" });
    expect(requests).toEqual(["POST /_matrix/client/v3/login"]);
  },
);

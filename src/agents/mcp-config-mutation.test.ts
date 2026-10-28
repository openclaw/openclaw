import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { withContendedConfigMutation } from "../../test/helpers/config-mutation-lock.js";
import { createDeferred } from "../../test/helpers/promise.js";
import * as config from "../config/config.js";
import { listConfiguredMcpServers, mcpConfigInternal } from "../config/mcp-config.js";
import { readGatewayLockProcessNamespace } from "../infra/gateway-lock-payload.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { closeStateDatabaseForTest as closeState } from "../test-utils/database-cleanup.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import {
  setConfiguredMcpServer as setServer,
  unsetConfiguredMcpServer as unsetServer,
  updateConfiguredMcpServer as updateServer,
  updateConfiguredMcpServerTools as updateTools,
} from "./mcp-config-mutation.js";
import { withMcpLifecycleLease } from "./mcp-lifecycle-lease.js";
import { operatorMcpOAuthIdentity, requesterMcpOAuthIdentity } from "./mcp-oauth-identity.js";
import { readMcpOAuthPendingAuthorization, readMcpOAuthStore } from "./mcp-oauth-store.js";
import { seedMcpOAuthStoreForTest } from "./mcp-oauth.test-support.js";

const SERVER_URL = "https://mcp.example.com/rpc";
const PER_REQUESTER_SERVER = {
  url: SERVER_URL,
  transport: "streamable-http",
  auth: "oauth",
  oauth: { identity: "per-requester" },
};
const STDIO_SERVER = { command: "uvx", args: ["operator-mcp"] };

async function install(server: Parameters<typeof setServer>[0]["server"] = PER_REQUESTER_SERVER) {
  const result = await setServer({ name: "fixture", server });
  expect(result.ok).toBe(true);
  return result;
}

function seedOAuthState() {
  const operator = operatorMcpOAuthIdentity("fixture", SERVER_URL);
  const requester = requesterMcpOAuthIdentity("fixture", SERVER_URL, {
    requesterSenderId: "alice",
    messageChannel: "telegram",
  });
  for (const identity of [operator, requester]) {
    seedMcpOAuthStoreForTest(
      identity.storeKey,
      { tokens: { access_token: identity.principal, token_type: "Bearer" } },
      `${identity.principal}-state`,
    );
  }
  return { operator, requester };
}

afterEach(() => vi.unstubAllEnvs());

it.aroundEach((run) =>
  withTempHome(
    async () => {
      await closeState();
      try {
        await run();
      } finally {
        await closeState();
      }
    },
    {
      prefix: "openclaw-mcp-config-oauth-",
      skipSessionCleanup: true,
      env: {
        OPENCLAW_CONFIG_PATH: undefined,
        OPENCLAW_STATE_DIR: (home) => path.join(home, ".openclaw"),
      },
    },
  ),
);
it.each(["keep", "replace"] as const)(
  "keeps MCP mutation ownership off the host with %s custody",
  async (ending) => {
    const databasePath = resolveOpenClawStateSqlitePath();
    const owner = acquireGatewayStateOwner({
      databasePath,
      payload: {
        pid: process.pid,
        role: "gateway",
        createdAt: new Date().toISOString(),
        configPath: `${databasePath}.config`,
        processNamespace: readGatewayLockProcessNamespace(),
      },
    });
    try {
      const initial = await install(STDIO_SERVER);
      const originalConfig = await fs.readFile(initial.path, "utf8");
      const originalOwner = await fs.readFile(owner.path);
      const lstat = syncFs.lstatSync;
      const stat = syncFs.statSync;
      const realpath = syncFs.realpathSync.native;
      const pause = new Int32Array(new SharedArrayBuffer(4));
      const hostOwnershipReads = { owner: 0, database: 0, identity: 0 };
      let hostLeaseStatements = 0;
      const hostProbe = vi.spyOn(syncFs, "lstatSync").mockImplementation((pathname, options) => {
        if (String(pathname) === owner.path) {
          hostOwnershipReads.owner++;
          Atomics.wait(pause, 0, 0, 20);
        }
        return lstat(pathname, options);
      });
      const databaseProbe = vi.spyOn(syncFs, "statSync").mockImplementation((pathname, options) => {
        if (String(pathname) === databasePath) {
          hostOwnershipReads.database++;
          Atomics.wait(pause, 0, 0, 20);
        }
        return stat(pathname, options);
      });
      const identityProbe = vi
        .spyOn(syncFs.realpathSync, "native")
        .mockImplementation((pathname, options) => {
          if ([databasePath, path.dirname(owner.path)].includes(String(pathname))) {
            hostOwnershipReads.identity++;
            Atomics.wait(pause, 0, 0, 20);
          }
          return realpath(pathname, options);
        });
      const sql = observeMainThreadSql({
        onStatement: (statement) => {
          if (/\bstate_leases\b/u.test(statement)) {
            hostLeaseStatements++;
          }
        },
      });
      config.setRuntimeConfigSnapshotRefreshHandler({
        preflight: async () => {
          if (ending === "replace") {
            await fs.writeFile(owner.path, "replacement");
          }
        },
        refresh: () => true,
      });
      try {
        const mutation = updateTools({ name: "fixture", tools: { include: ["search"] } });
        if (ending === "replace") {
          await expect(mutation).rejects.toThrow();
          expect(await fs.readFile(initial.path, "utf8")).toBe(originalConfig);
        } else {
          expect(await mutation).toMatchObject({ ok: true });
          expect(
            JSON.parse(await fs.readFile(initial.path, "utf8")).mcp.servers.fixture.toolFilter,
          ).toEqual({
            include: ["search"],
          });
        }
        expect(hostOwnershipReads).toEqual({ owner: 0, database: 0, identity: 0 });
        expect(hostLeaseStatements).toBe(0);
      } finally {
        hostProbe.mockRestore();
        databaseProbe.mockRestore();
        identityProbe.mockRestore();
        sql.restore();
        config.setRuntimeConfigSnapshotRefreshHandler(null);
        await fs.writeFile(owner.path, originalOwner);
      }
    } finally {
      owner.release();
      await closeState();
    }
  },
);

it("preserves config and OAuth credentials when deletion authority expires during preflight", async () => {
  const initial = await install();
  const { operator, requester } = seedOAuthState();
  const raw = await fs.readFile(initial.path, "utf8");
  let active = true;
  config.setRuntimeConfigSnapshotRefreshHandler({
    preflight: () => {
      active = false;
    },
    refresh: () => true,
  });
  try {
    await expect(
      unsetServer({
        name: "fixture",
        assertCurrentAsync: async () => {
          if (!active) {
            throw new Error("deletion authority expired");
          }
        },
      }),
    ).rejects.toThrow("deletion authority expired");
    expect(await fs.readFile(initial.path, "utf8")).toBe(raw);
    expect((await readMcpOAuthStore(operator.storeKey)).tokens?.access_token).toBe("operator");
    expect((await readMcpOAuthStore(requester.storeKey)).tokens?.access_token).toBe("requester");
  } finally {
    config.setRuntimeConfigSnapshotRefreshHandler(null);
  }
});

it.each([
  ["replacement", () => install({ command: "uvx", args: ["replacement-mcp"] }), []],
  ["unset", () => unsetServer({ name: "fixture" }), []],
  [
    "identity flip",
    () => updateServer({ name: "fixture", update: (server) => ({ ...server, oauth: {} }) }),
    ["operator"],
  ],
  [
    "tool update",
    () => updateTools({ name: "fixture", tools: { include: ["search"] } }),
    ["operator", "requester"],
  ],
] as const)(
  "applies cleanup and preserves env references after %s",
  async (_name, mutate, retained) => {
    const { path: configPath } = await install();
    const identities = seedOAuthState();
    const kept = new Set<string>(retained);
    const authored = JSON.parse(await fs.readFile(configPath, "utf8"));
    authored.messages = { responsePrefix: "${OPENCLAW_TEST_MCP_PREFIX}" };
    vi.stubEnv("OPENCLAW_TEST_MCP_PREFIX", "before-lock");
    const raw = JSON.stringify(authored);
    await fs.writeFile(configPath, raw);
    const result = await withContendedConfigMutation(configPath, mutate, async () => {
      expect(await fs.readFile(configPath, "utf8")).toBe(raw);
      vi.stubEnv("OPENCLAW_TEST_MCP_PREFIX", "after-lock");
    });

    expect(result.ok).toBe(true);
    expect(JSON.parse(await fs.readFile(configPath, "utf8")).messages.responsePrefix).toBe(
      "${OPENCLAW_TEST_MCP_PREFIX}",
    );
    expect(await config.readConfigFileSnapshot()).toMatchObject({
      valid: true,
      sourceConfig: { messages: { responsePrefix: "after-lock" } },
    });
    for (const principal of ["operator", "requester"] as const) {
      const { storeKey } = identities[principal];
      expect((await readMcpOAuthStore(storeKey)).tokens?.access_token).toBe(
        kept.has(principal) ? principal : undefined,
      );
      expect(await readMcpOAuthPendingAuthorization(`${principal}-state`)).toBe(
        kept.has(principal) ? storeKey : undefined,
      );
    }
  },
);
it("waits for active Claw ownership reconciliation before an ordinary mutation", async () => {
  const leaseEntered = createDeferred();
  const releaseLease = createDeferred();
  const order: string[] = [];
  using set = vi.spyOn(mcpConfigInternal, "set").mockImplementation(async () => ({
    ok: true,
    path: "config",
    config: {},
    mcpServers: {},
  }));
  const lifecycle = withMcpLifecycleLease("fixture", {}, async () => {
    order.push("lifecycle");
    leaseEntered.resolve();
    await releaseLease.promise;
  });
  await leaseEntered.promise;

  const mutation = setServer({ name: " fixture ", server: STDIO_SERVER }).then((result) => {
    order.push("operator");
    return result;
  });
  await Promise.resolve();
  expect(set).not.toHaveBeenCalled();
  expect(order).toEqual(["lifecycle"]);

  releaseLease.resolve();
  await lifecycle;
  expect((await mutation).ok).toBe(true);
  expect(set).toHaveBeenCalledOnce();
  expect(order).toEqual(["lifecycle", "operator"]);
});

it("preserves the canonical validation result for an empty server name", async () => {
  expect(await setServer({ name: " ", server: STDIO_SERVER })).toEqual({
    ok: false,
    path: "",
    error: "MCP server name is required.",
  });
});
it("keeps write metadata private and leaves no-change config bytes untouched", async () => {
  const initial = await install({ command: "node" });
  const raw = await fs.readFile(initial.path, "utf8");
  const listed = await listConfiguredMcpServers();
  expect(listed.ok).toBe(true);
  expect(listed).not.toHaveProperty("writeOptions");
  expect(listed).not.toHaveProperty("snapshot");
  const missing = await unsetServer({ name: "missing" });
  expect(missing).toMatchObject({ ok: true, removed: false });
  expect(Object.keys(missing)).not.toContain("writeOptions");
  expect(Object.keys(missing)).not.toContain("snapshot");
  expect(await fs.readFile(initial.path, "utf8")).toBe(raw);
});

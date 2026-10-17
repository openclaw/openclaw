import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withContendedConfigMutation } from "../../test/helpers/config-mutation-lock.js";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  readConfigFileSnapshot,
  setRuntimeConfigSnapshotRefreshHandler,
} from "../config/config.js";
import { listConfiguredMcpServers, mcpConfigInternal } from "../config/mcp-config.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import {
  setConfiguredMcpServer,
  unsetConfiguredMcpServer,
  updateConfiguredMcpServer,
  updateConfiguredMcpServerTools,
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

async function install(
  server: Parameters<typeof setConfiguredMcpServer>[0]["server"] = PER_REQUESTER_SERVER,
) {
  const result = await setConfiguredMcpServer({ name: "fixture", server });
  expect(result.ok).toBe(true);
  return result;
}

async function closeState() {
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
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

afterEach(async () => {
  await closeState();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function withMcpConfigHome(run: () => Promise<void>): Promise<void> {
  await withTempHome(
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
  );
}

describe("configured MCP OAuth cleanup", () => {
  it.aroundEach((runTest) => withMcpConfigHome(runTest));
  it("preserves config and OAuth credentials when deletion authority expires during preflight", async () => {
    const initial = await install();
    const { operator, requester } = seedOAuthState();
    const raw = await fs.readFile(initial.path, "utf8");
    let active = true;
    setRuntimeConfigSnapshotRefreshHandler({
      preflight: () => {
        active = false;
      },
      refresh: () => true,
    });
    try {
      await expect(
        unsetConfiguredMcpServer({
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
      setRuntimeConfigSnapshotRefreshHandler(null);
    }
  });

  it.each([
    ["replacement", () => install({ command: "uvx", args: ["replacement-mcp"] }), []],
    ["unset", () => unsetConfiguredMcpServer({ name: "fixture" }), []],
    [
      "identity flip",
      () =>
        updateConfiguredMcpServer({
          name: "fixture",
          update: (server) => ({ ...server, oauth: {} }),
        }),
      ["operator"],
    ],
    [
      "tool update",
      () =>
        updateConfiguredMcpServerTools({
          name: "fixture",
          tools: { include: ["search"] },
        }),
      ["operator", "requester"],
    ],
  ] as const)(
    "applies cleanup and preserves env references after %s",
    async (_name, mutate, retained) => {
      const initial = await install();
      const identities = seedOAuthState();
      const kept = new Set<string>(retained);
      const configPath = initial.path;
      const config = JSON.parse(await fs.readFile(configPath, "utf8"));
      config.messages = { responsePrefix: "${OPENCLAW_TEST_MCP_PREFIX}" };
      vi.stubEnv("OPENCLAW_TEST_MCP_PREFIX", "before-lock");
      const raw = JSON.stringify(config);
      await fs.writeFile(configPath, raw);
      const result = await withContendedConfigMutation(configPath, mutate, async () => {
        expect(await fs.readFile(configPath, "utf8")).toBe(raw);
        vi.stubEnv("OPENCLAW_TEST_MCP_PREFIX", "after-lock");
      });

      expect(result.ok).toBe(true);
      expect(JSON.parse(await fs.readFile(configPath, "utf8")).messages.responsePrefix).toBe(
        "${OPENCLAW_TEST_MCP_PREFIX}",
      );
      const fresh = await readConfigFileSnapshot();
      expect(fresh).toMatchObject({
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
    const set = vi.spyOn(mcpConfigInternal, "set").mockImplementation(async () => ({
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

    const mutation = setConfiguredMcpServer({
      name: " fixture ",
      server: STDIO_SERVER,
    }).then((result) => {
      order.push("operator");
      return result;
    });
    await Promise.resolve();
    expect(set).not.toHaveBeenCalled();
    expect(order).toEqual(["lifecycle"]);

    releaseLease.resolve();
    await lifecycle;
    const result = await mutation;

    expect(result.ok).toBe(true);
    expect(set).toHaveBeenCalledOnce();
    expect(order).toEqual(["lifecycle", "operator"]);
  });

  it("preserves the canonical validation result for an empty server name", async () => {
    const result = await setConfiguredMcpServer({
      name: " ",
      server: STDIO_SERVER,
    });

    expect(result).toEqual({
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
    expect(Object.keys(listed).toSorted()).toEqual([
      "authoredConfig",
      "baseHash",
      "config",
      "mcpServers",
      "ok",
      "path",
      "runtimeConfig",
      "sourceConfigBeforeMigrations",
    ]);
    const missing = await unsetConfiguredMcpServer({ name: "missing" });
    expect(missing).toMatchObject({ ok: true, removed: false });
    expect(Object.keys(missing)).not.toContain("writeOptions");
    expect(Object.keys(missing)).not.toContain("snapshot");
    expect(await fs.readFile(initial.path, "utf8")).toBe(raw);
  });
});

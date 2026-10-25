import * as childProcess from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { upsertAuthProfile } from "openclaw/plugin-sdk/provider-auth";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  awaitGateBeforeSettlement,
  withinTest,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { CodexPluginConfig } from "./config.js";
import { createCodexAppServerModelCatalog } from "./model-catalog.js";
import {
  clearSharedCodexAppServerClientAndWait,
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import { createCodexTestOAuthProfile } from "./test-support.js";
import { CODEX_APP_SERVER_VERSION } from "./version.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
}));

describe.skipIf(process.platform === "win32")("Codex model discovery process lifetime", () => {
  const dirs = useSessionStoreTempDirs(afterAll, "codex-model-lifetime-");
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("authenticates catalog discovery with environment keys and explicit profiles", async () => {
    const root = dirs.make();
    const executable = path.join(root, "catalog.mjs");
    const nativeHome = path.join(root, "native-home");
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("CODEX_HOME", nativeHome);
    vi.stubEnv("CODEX_ACCESS_TOKEN", "");
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "synthetic-environment-key");
    await fs.mkdir(nativeHome, { recursive: true });
    await fs.writeFile(
      path.join(nativeHome, "auth.json"),
      JSON.stringify({ OPENAI_API_KEY: "synthetic-native-home-key" }),
      { mode: 0o600 },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        throw new Error("Catalog auth fixture must not access the network");
      }),
    );
    await fs.writeFile(
      executable,
      `
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
if (process.argv.includes("login")) {
  process.stdout.write("Logged in using ChatGPT\\n");
  process.exit(0);
}
let account = process.argv.includes("--existing-chatgpt") ? { type: "chatgpt" } : null;
let logins = 0;
let keyVersion = null;
let pendingStartupNotification = false;
function notifyAccountUpdated() {
  process.stdout.write(JSON.stringify({ method: "account/updated", params: { authMode: account.type, planType: null } }) + "\\n");
}
createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (!message.id) return;
    let result = {};
    let changeAfterRead = false;
    if (message.method === "initialize") {
      result = { userAgent: "codex-cli/${CODEX_APP_SERVER_VERSION}", codexHome: process.env.CODEX_HOME };
    } else if (message.method === "account/login/start") {
      logins++;
      pendingStartupNotification = true;
      keyVersion = message.params.apiKey === "synthetic-rotated-key" ? "rotated" : "original";
      account = { type: message.params.type === "apiKey" ? "apiKey" : "chatgpt" };
      result = { type: message.params.type };
    } else if (message.method === "model/list") {
      if (process.argv.includes("--change-during-list")) {
        account = { type: "chatgpt" };
        notifyAccountUpdated();
      }
      result = { data: [{ id: "synthetic-model", model: "synthetic-model", displayName: "Synthetic model", description: "Fixture", hidden: false, isDefault: true, defaultReasoningEffort: "medium", inputModalities: ["text"], supportedReasoningEfforts: [] }], nextCursor: null };
    } else if (message.method === "account/read") {
      // Native account-auth serialization drains login notifications before this response.
      if (pendingStartupNotification) {
        changeAfterRead = process.argv.includes("--change-after-startup");
        pendingStartupNotification = false;
        notifyAccountUpdated();
      }
      result = { account, requiresOpenaiAuth: true };
      fs.writeFileSync(path.join(process.env.CODEX_HOME, "catalog-account.json"), JSON.stringify({ ...result, logins, keyVersion }));
    }
    let response = JSON.stringify({ id: message.id, result }) + "\\n";
    if (changeAfterRead) {
      account = { type: "chatgpt" };
      response += JSON.stringify({ method: "account/updated", params: { authMode: "chatgpt", planType: null } }) + "\\n";
    }
    process.stdout.write(response);
});
process.stdin.on("end", () => process.exit(0));
`,
    );
    for (const [mode, accountType, logins, flag] of [
      ["environment", "apiKey", 1],
      ["api-key-profile", "apiKey", 1],
      ["subscription-profile", "chatgpt", 1],
      ["account-change", undefined, 1, "--change-during-list"],
      ["account-change-after-startup", "chatgpt", 1, "--change-after-startup"],
      ["absent-key", undefined, 0],
      ["existing-account", "chatgpt", 0],
      ["native-home", "chatgpt", 0],
      ["proxy", "chatgpt", 0],
    ] as const) {
      const agentDir = path.join(root, mode);
      vi.stubEnv("OPENAI_API_KEY", mode === "absent-key" ? "" : "synthetic-environment-key");
      if (mode === "api-key-profile" || mode === "subscription-profile") {
        upsertAuthProfile({
          agentDir,
          profileId: "openai:catalog",
          credential:
            mode === "api-key-profile"
              ? { type: "api_key", provider: "openai", key: "synthetic-profile-key" }
              : {
                  type: "token",
                  provider: "openai",
                  token: createCodexTestOAuthProfile("synthetic-catalog-account").access,
                },
        });
      }
      const config = { auth: { order: { openai: ["openai:catalog"] } } };
      const existing = mode === "existing-account" || mode === "native-home" || mode === "proxy";
      const pluginConfig = {
        appServer: {
          command: process.execPath,
          args: [
            executable,
            ...(existing ? ["--existing-chatgpt"] : []),
            ...(flag ? [flag] : []),
            "app-server",
            ...(mode === "proxy" ? ["proxy"] : []),
          ],
          ...(mode === "native-home" ? { homeScope: "user" } : {}),
        },
      };
      const catalogHome = mode === "native-home" ? nativeHome : path.join(agentDir, "codex-home");
      await fs.mkdir(catalogHome, { recursive: true });
      const readAccount = async () =>
        JSON.parse(await fs.readFile(path.join(catalogHome, "catalog-account.json"), "utf8"));
      const catalog = createCodexAppServerModelCatalog("codex");
      const params = { config, agentId: "main", agentDir, workspaceDir: root };
      const check = (value: unknown, label: string = mode) => expect.soft(value, label);
      try {
        const result = await catalog.load(params, pluginConfig);
        const readiness = catalog.read(
          { ...params, provider: "openai", modelId: "synthetic-model" },
          pluginConfig,
        );
        if (mode === "account-change") {
          check(result).toEqual({ entries: [] });
          check(readiness).toBeUndefined();
          continue;
        }
        check(readiness?.accountType).toBe(accountType);
        check(result.outcomes).toEqual([
          {
            provider: "openai",
            status: mode === "absent-key" ? "unavailable" : "ready",
            ...(accountType === "chatgpt" ? { modelAccessPrograms: [] } : {}),
          },
        ]);
        check(result.entries).toContainEqual(expect.objectContaining({ id: "synthetic-model" }));
        check(await readAccount()).toEqual({
          account: accountType ? { type: accountType } : null,
          requiresOpenaiAuth: true,
          logins,
          keyVersion: logins ? "original" : null,
        });
        if (mode === "environment") {
          vi.stubEnv("OPENAI_API_KEY", "synthetic-rotated-key");
          await catalog.load(params, pluginConfig);
          check(await readAccount(), "rotated environment key").toMatchObject({
            account: { type: "apiKey" },
            logins: 1,
            keyVersion: "rotated",
          });
        }
      } finally {
        catalog.dispose();
        await clearSharedCodexAppServerClientAndWait();
      }
    }
  });

  it("retires timed-out discovery without interrupting a sibling lease, then reaps the pair", async ({
    signal,
  }) => {
    const bounded = <T>(operation: Promise<T>) => withinTest(operation, signal);
    const root = dirs.make();
    const agentDir = path.join(root, "agent");
    const workspaceDir = path.join(root, "workspace");
    const executable = path.join(root, "codex.mjs");
    const receipts = await openFixtureReceiptChannel();
    const children: { child: childProcess.ChildProcess; closed: Promise<unknown> }[] = [];
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("CODEX_API_KEY", "");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(
      executable,
      `
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
${fixtureReceiptClientSource(receipts.endpoint)}
if (process.argv.includes("--native")) {
  fs.writeFileSync(path.join(process.env.CODEX_HOME, "native.pid"), String(process.pid));
  createInterface({ input: process.stdin }).on("line", (line) => {
      const message = JSON.parse(line);
      const results = {
        initialize: {
          userAgent: "codex-cli/${CODEX_APP_SERVER_VERSION}", codexHome: process.env.CODEX_HOME,
        },
        "account/read": { account: null, requiresOpenaiAuth: true },
        "config/read": { config: {} },
      };
      if (message.method === "model/list") {
        sendReceipt("discovery", "pending");
      } else if (message.method in results) {
        process.stdout.write(JSON.stringify({ id: message.id, result: results[message.method] }) + "\\n");
      }
  });
  process.stdin.on("end", () => process.exit(0));
} else {
  const child = spawn(process.execPath, [process.argv[1], "--native"], { stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  child.on("exit", (code) => process.exit(code ?? 1));
}
`,
    );
    const spawn = childProcess.spawn;
    vi.spyOn(childProcess, "spawn").mockImplementation((...args) => {
      const child = spawn(...args);
      if (Array.isArray(args[1]) && args[1].includes(executable)) {
        children.push({ child, closed: once(child, "close") });
      }
      return child;
    });
    const pluginConfig = {
      discovery: { timeoutMs: 5_000 },
      appServer: {
        command: process.execPath,
        args: [executable, "app-server"],
        homeScope: "agent",
      },
    } satisfies CodexPluginConfig;
    const config = {
      agents: {
        ownership: "explicit" as const,
        entries: { main: { agentDir, workspace: workspaceDir } },
      },
    };
    const catalog = createCodexAppServerModelCatalog("codex");
    const leases: Awaited<ReturnType<typeof getLeasedSharedCodexAppServerClient>>[] = [];
    let settled: Promise<unknown> | undefined;
    try {
      const options = {
        config,
        agentDir,
        pluginConfig,
        timeoutMs: 5_000,
        authRequirement: "environment-api-key" as const,
      };
      const sibling = await bounded(getLeasedSharedCodexAppServerClient(options));
      leases.push(sibling);
      expect(children).toHaveLength(1);
      const first = children[0];
      const firstPid = sibling.getTransportPid();
      if (!first || firstPid === undefined) {
        throw new Error("The shared client did not spawn a local transport");
      }
      expect(firstPid).toBe(first.child.pid);
      const nativePid = Number(
        await fs.readFile(path.join(agentDir, "codex-home", "native.pid"), "utf8"),
      );
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      const loading = catalog.load(
        { config, agentId: "main", agentDir, workspaceDir },
        pluginConfig,
      );
      settled = loading.catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      await bounded(
        awaitGateBeforeSettlement(
          receipts.waitFor("discovery", "pending"),
          loading,
          "Discovery settled before sending model/list",
        ),
      );
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await settled).toMatchObject({ message: expect.stringContaining("timed out") });
      vi.useRealTimers();
      await expect(sibling.request("config/read", {})).resolves.toEqual({ config: {} });
      const replacement = await bounded(getLeasedSharedCodexAppServerClient(options));
      leases.push(replacement);
      expect(replacement.getTransportPid(), "timed-out discovery remained pooled").not.toBe(
        sibling.getTransportPid(),
      );
      expect(children).toHaveLength(2);
      expect(first.child.exitCode).toBeNull();
      releaseLeasedSharedCodexAppServerClient(sibling);
      leases.shift();
      await bounded(first.closed);
      for (const pid of [firstPid, nativePid]) {
        expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      }
    } finally {
      vi.useRealTimers();
      for (const client of leases) {
        releaseLeasedSharedCodexAppServerClient(client);
      }
      await clearSharedCodexAppServerClientAndWait();
      await Promise.all(children.map(({ closed }) => closed));
      await settled;
      catalog.dispose();
      await receipts.close();
    }
  });
});

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
import { afterAll, describe, expect, it, vi } from "vitest";
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

  it("authenticates catalog discovery with environment keys and explicit profiles", async () => {
    const root = dirs.make();
    const executable = path.join(root, "catalog.mjs");
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
    vi.stubEnv("CODEX_HOME", path.join(root, "native-home"));
    vi.stubEnv("CODEX_ACCESS_TOKEN", "");
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "synthetic-environment-key");
    await fs.mkdir(path.join(root, "native-home"), { recursive: true });
    await fs.writeFile(
      path.join(root, "native-home", "auth.json"),
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
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf("\\n");
    if (end < 0) break;
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (!message.id) continue;
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
  }
});
process.stdin.on("end", () => process.exit(0));
`,
    );
    try {
      for (const mode of [
        "environment",
        "api-key-profile",
        "subscription-profile",
        "account-change",
        "account-change-after-startup",
        "absent-key",
        "existing-account",
        "native-home",
        "proxy",
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
              ...(mode === "account-change" ? ["--change-during-list"] : []),
              ...(mode === "account-change-after-startup" ? ["--change-after-startup"] : []),
              "app-server",
              ...(mode === "proxy" ? ["proxy"] : []),
            ],
            ...(mode === "native-home" ? { homeScope: "user" } : {}),
          },
        };
        const catalogHome =
          mode === "native-home"
            ? path.join(root, "native-home")
            : path.join(agentDir, "codex-home");
        await fs.mkdir(catalogHome, { recursive: true });
        const readAccount = async () =>
          JSON.parse(await fs.readFile(path.join(catalogHome, "catalog-account.json"), "utf8"));
        const catalog = createCodexAppServerModelCatalog("codex");
        try {
          const result = await catalog.load(
            { config, agentId: "main", agentDir, workspaceDir: root },
            pluginConfig,
          );
          const readiness = catalog.read(
            {
              config,
              agentId: "main",
              agentDir,
              workspaceDir: root,
              provider: "openai",
              modelId: "synthetic-model",
            },
            pluginConfig,
          );
          if (mode === "account-change") {
            expect.soft(result, mode).toEqual({ entries: [] });
            expect.soft(readiness, mode).toBeUndefined();
            continue;
          }
          const accountType =
            mode === "absent-key"
              ? undefined
              : mode === "subscription-profile" ||
                  mode === "account-change-after-startup" ||
                  existing
                ? "chatgpt"
                : "apiKey";
          expect.soft(readiness?.accountType, mode).toBe(accountType);
          expect
            .soft(result.outcomes, mode)
            .toEqual([
              { provider: "openai", status: mode === "absent-key" ? "unavailable" : "ready" },
            ]);
          expect
            .soft(result.entries, mode)
            .toContainEqual(expect.objectContaining({ id: "synthetic-model" }));
          expect.soft(await readAccount(), mode).toEqual({
            account: accountType ? { type: accountType } : null,
            requiresOpenaiAuth: true,
            logins: mode === "absent-key" || existing ? 0 : 1,
            keyVersion: mode === "absent-key" || existing ? null : "original",
          });
          if (mode === "environment") {
            vi.stubEnv("OPENAI_API_KEY", "synthetic-rotated-key");
            await catalog.load(
              { config, agentId: "main", agentDir, workspaceDir: root },
              pluginConfig,
            );
            expect
              .soft(await readAccount(), "rotated environment key")
              .toMatchObject({ account: { type: "apiKey" }, logins: 1, keyVersion: "rotated" });
          }
        } finally {
          catalog.dispose();
          await clearSharedCodexAppServerClientAndWait();
        }
      }
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  it("retires timed-out discovery without interrupting a sibling lease, then reaps the pair", async ({
    signal,
  }) => {
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
${fixtureReceiptClientSource(receipts.endpoint)}
if (process.argv.includes("--native")) {
  fs.writeFileSync(path.join(process.env.CODEX_HOME, "native.pid"), String(process.pid));
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf("\\n");
      if (end < 0) break;
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.method === "initialize") {
        process.stdout.write(JSON.stringify({ id: message.id, result: {
          userAgent: "codex-cli/${CODEX_APP_SERVER_VERSION}", codexHome: process.env.CODEX_HOME,
        } }) + "\\n");
      } else if (message.method === "account/read") {
        process.stdout.write(JSON.stringify({ id: message.id, result: { account: null, requiresOpenaiAuth: true } }) + "\\n");
      } else if (message.method === "model/list") {
        sendReceipt("discovery", "pending");
      } else if (message.method === "config/read") {
        process.stdout.write(JSON.stringify({ id: message.id, result: { config: {} } }) + "\\n");
      }
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
    };
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
      const sibling = await withinTest(getLeasedSharedCodexAppServerClient(options), signal);
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
      settled = loading.then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(0);
      await withinTest(
        awaitGateBeforeSettlement(
          receipts.waitFor("discovery", "pending"),
          loading,
          "Discovery settled before sending model/list",
        ),
        signal,
      );
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await settled).toEqual(
        expect.objectContaining({ message: expect.stringContaining("timed out") }),
      );
      vi.useRealTimers();
      await expect(sibling.request("config/read", {})).resolves.toEqual({ config: {} });
      const replacement = await withinTest(getLeasedSharedCodexAppServerClient(options), signal);
      leases.push(replacement);
      expect(replacement.getTransportPid(), "timed-out discovery remained pooled").not.toBe(
        sibling.getTransportPid(),
      );
      expect(children).toHaveLength(2);
      expect(first.child.exitCode).toBeNull();
      releaseLeasedSharedCodexAppServerClient(sibling);
      leases.shift();
      await withinTest(first.closed, signal);
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
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    }
  });
});

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { runQaGatewayCliCommand } from "./gateway-child-command.js";
import { QaGatewayChildLifecycle } from "./gateway-child-lifecycle.js";
import { waitForGatewayListening, waitForGatewayReady } from "./gateway-child-readiness.js";
import { prepareQaGatewayChild } from "./gateway-child-setup.js";
import { startQaGatewayRpcClient } from "./gateway-rpc-client.js";
import { resolveQaNodeExecPath } from "./node-exec.js";

const lifetimes: QaGatewayChildLifecycle[] = [];
afterEach(async () => {
  for (const lifetime of lifetimes.splice(0)) {
    const result = await lifetime.stop({ keepTemp: false });
    expect(result.errors).toEqual([]);
  }
});

it(
  "automatically admits fresh and populated startup, but refuses invalid canonical state",
  { timeout: 360_000 },
  async () => {
    const lifetime = new QaGatewayChildLifecycle();
    lifetimes.push(lifetime);
    const repoRoot = path.resolve(import.meta.dirname, "../../..");
    const nodeExecutable = await resolveQaNodeExecPath();
    const prepared = await prepareQaGatewayChild(
      {
        repoRoot,
        // Current-repository startup must not depend on QA initialization or repair.
        useRepoCli: true,
        transportBaseUrl: "http://127.0.0.1:43123",
        providerBaseUrl: "http://127.0.0.1:44080/v1",
        providerMode: "mock-openai",
        controlUiEnabled: false,
        enabledPluginIds: ["qa-channel"],
        mutateConfig: (config) => ({
          ...config,
          models: { ...config.models, catalogRefresh: { enabled: false } },
          update: { ...config.update, checkOnStart: false },
          channels: {
            ...config.channels,
            "qa-channel": {
              ...config.channels?.["qa-channel"],
              defaultAccount: "default",
              accounts: {
                default: { name: "Default" },
                work: { name: "Work" },
                disabled: { name: "Disabled", enabled: false },
              },
            },
          },
        }),
      },
      lifetime,
    );
    // Prepare once: subsequent launches use the same config and persisted stores.
    const launch = await prepared.prepareAttempt();
    const sourceUrl = (relativePath: string) =>
      pathToFileURL(path.join(repoRoot, relativePath)).href;
    const runFixtureScript = (script: string, runtimePath = "src/plugin-sdk/qa-runtime.ts") =>
      runQaGatewayCliCommand({
        lifetime,
        executablePath: nodeExecutable,
        argsPrefix: ["--import", path.join(repoRoot, "scripts/tsx.mjs")],
        args: [
          "--input-type=module",
          "--eval",
          `const runtime = await import(${JSON.stringify(sourceUrl(runtimePath))});
         try { ${script} }
         finally { await runtime.closeQaRuntimeStores(${JSON.stringify(prepared.tempRoot)}); }`,
        ],
        cwd: repoRoot,
        env: launch.env,
      });

    for (const phase of [
      "fresh",
      "fresh-repeat",
      "populated",
      "populated-repeat",
      "invalid",
    ] as const) {
      if (phase === "populated" || phase === "invalid") {
        // Offline fixture imports revoke canonical proof through its owner. Never
        // fabricate a successful validation receipt or retain a second writer.
        await runFixtureScript(`
        const { openOpenClawAgentDatabase } = await import(${JSON.stringify(sourceUrl("src/state/openclaw-agent-db.ts"))});
        const { markCanonicalSessionValidationPending } = await import(${JSON.stringify(sourceUrl("src/config/sessions/session-canonical-key.ts"))});
        const database = openOpenClawAgentDatabase({ agentId: "qa", env: process.env });
        database.db.exec("BEGIN IMMEDIATE");
        ${
          phase === "populated"
            ? `database.db.prepare("INSERT INTO session_nodes (session_key,current_session_id,entry_json,entry_valid,updated_at) VALUES (?,?,?,?,?)").run("agent:qa:pending-fixture", "pending-fixture", JSON.stringify({ sessionId: "pending-fixture", updatedAt: 1 }), 1, 1);`
            : `database.db.prepare("UPDATE session_nodes SET entry_valid = 0 WHERE session_key = ?").run("agent:qa:pending-fixture");`
        }
        markCanonicalSessionValidationPending(database);
        database.db.exec("COMMIT");
      `);
      }
      const child = spawn(prepared.nodeExecPath, prepared.buildGatewayArgs(), {
        cwd: prepared.gatewayCwd,
        env: launch.env,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const owned = lifetime.register(child, null);
      let output = "";
      child.stdout.on("data", (bytes) => {
        output = (output + bytes).slice(-16000);
      });
      child.stderr.on("data", (bytes) => {
        output = (output + bytes).slice(-16000);
      });
      const health = {
        baseUrl: launch.baseUrl,
        logs: () => output,
        child,
        getChildFailure: () => null,
        timeoutMs: 120_000,
      };
      if (phase === "invalid") {
        // Refuse the actual invalid row, not a timeout or an unrelated setup error.
        await expect(waitForGatewayReady(health)).rejects.toThrow(
          /SESSION_CANONICAL_KEY_MIGRATION_REQUIRED|invalid persisted session row requires repair/,
        );
      } else {
        await waitForGatewayListening(health);
        await waitForGatewayReady(health);
        lifetime.rpcClient = await startQaGatewayRpcClient({
          wsUrl: launch.wsUrl,
          token: prepared.gatewayToken,
          logs: () => output,
        });
        await lifetime.rpcClient.request("config.get", {}, { timeoutMs: 30_000 });
        owned.ready = true;
        await vi.waitFor(
          () => expect(output).toMatch(/startup phase: post-ready.startup-maintenance \d/),
          { timeout: 60_000, interval: 100 },
        );
        await lifetime.rpcClient.stop();
        lifetime.rpcClient = null;
      }
      expect(await lifetime.stopProcess()).toEqual({ process: "confirmed-stopped", errors: [] });
      if (phase === "invalid") {
        continue;
      }
      const snapshotPath = path.join(prepared.tempRoot, "startup-state.json");
      // This read-only owner snapshot also checks schema, plugin, workspace, auth,
      // credential and migration readiness; reading cannot make startup pass.
      await runFixtureScript(
        `const fs = await import("node:fs/promises");
         await fs.writeFile(${JSON.stringify(snapshotPath)}, JSON.stringify(await runtime.snapshotQaStartupState(process.env)));`,
        "dist/plugin-sdk/qa-runtime.js",
      );
      const observed: unknown = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
      expect(observed).toMatchObject({
        state: {
          shared: { startupReady: true },
          agents: [
            {
              agentId: "qa",
              canonicalEntries: phase.startsWith("fresh") ? 0 : 1,
              // Empty stores need no receipt; populated imports must be certified.
              ...(phase.startsWith("populated") ? { canonicalReceipt: true } : {}),
            },
          ],
        },
      });
    }
  },
);

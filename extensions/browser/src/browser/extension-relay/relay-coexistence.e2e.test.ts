import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it } from "vitest";
import {
  createBrowserControlContext,
  startBrowserControlServiceFromConfig,
  stopBrowserControlService,
} from "../../control-service.js";
import {
  externalRelayClient,
  externalVersion,
  withConnectedDaemon,
} from "./relay-coexistence.test-support.js";

afterEach(async () => {
  await stopBrowserControlService();
  clearRuntimeConfigSnapshot();
});

it("borrows the compiled daemon in another process and leaves it serving an external v2 client", async ({
  signal,
}) => {
  let child: ChildProcess | undefined;
  await withConnectedDaemon(
    async ({ port, token }) => {
      const pid = child?.pid;
      expect(pid).toBeTypeOf("number");
      const external = await externalRelayClient(port, token);
      try {
        await startBrowserControlServiceFromConfig();
        const profile = createBrowserControlContext().forProfile("chrome");
        await profile.ensureBrowserAvailable();
        await expect(profile.listTabs()).resolves.toMatchObject([
          {
            targetId: "fixture-target",
            url: "https://example.com/fixture",
          },
        ]);
        await stopBrowserControlService();
        expect(child).toMatchObject({ pid, exitCode: null });
        await expect(externalVersion(external)).resolves.toMatchObject({
          result: { product: "Chrome/test" },
        });
      } finally {
        external.terminate();
      }
    },
    async (port, stateDir, config) => {
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.writeFile(configPath, JSON.stringify(config));
      child = spawn(
        process.execPath,
        [path.resolve("dist/extensions/browser/relay-daemon-entry.js"), "--port", String(port)],
        {
          env: {
            HOME: stateDir,
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_CONFIG_PATH: configPath,
            PATH: process.env.PATH,
            TMPDIR: process.env.TMPDIR,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      const owned = child;
      const done = createDeferred<void>();
      const ready = createDeferred<void>();
      let output = "";
      const onData = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-4_096);
        if (output.includes("standalone extension relay listening")) {
          ready.resolve();
        }
      };
      owned.stdout?.on("data", onData);
      owned.stderr?.on("data", onData);
      owned.once("error", ready.reject);
      owned.once("exit", () => {
        done.resolve();
        ready.reject(new Error("Compiled relay exited before readiness"));
      });
      try {
        await withinTest(ready.promise, signal);
      } catch (error) {
        owned.kill("SIGTERM");
        await done.promise;
        throw error;
      }
      return { port, stop: () => owned.kill("SIGTERM"), done: done.promise };
    },
  );
});

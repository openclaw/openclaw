import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveNodeHostExecutable } from "openclaw/plugin-sdk/node-host";
import { useAutoCleanupTempDirTracker, withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./app-server/config-runtime.js";
import { codexControlRequest } from "./command-rpc.js";
import { createCodexSessionCatalogControl } from "./session-catalog-control.js";
import { subscribeCodexCatalogEvents } from "./session-catalog-events.js";
import { codexCatalogHomeId } from "./session-catalog-home-id.js";
import { createCodexSessionCatalogNodeHostCommands } from "./session-catalog-listing.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.skipIf(process.env.OPENCLAW_LIVE_TEST !== "1")(
  "discovers a new native rollout on the first warm node catalog read after terminal exit",
  async () => {
    const resolution = resolveNodeHostExecutable("codex", { strategy: "direct" });
    if (!resolution) {
      throw new Error("Install the native Codex CLI on PATH to run this test");
    }
    const home = tempDirs.make("codex-terminal-catalog-");
    const otherHome = tempDirs.make("codex-terminal-other-home-");
    await withEnvAsync(
      {
        CODEX_HOME: home,
      },
      async () => {
        const config = {};
        const pluginConfig = {
          appServer: { command: resolution.executable, homeScope: "user" as const },
        };
        const runtime = resolveCodexSupervisionAppServerRuntimeOptions({ pluginConfig });
        const factory = createCodexSessionCatalogControl({
          getPluginConfig: () => pluginConfig,
          getRuntimeConfig: () => config,
          resolveRuntimeOptions: resolveCodexSupervisionAppServerRuntimeOptions,
        });
        const commands = createCodexSessionCatalogNodeHostCommands(factory);
        const list = commands.find(
          (command) => command.command === "codex.appServer.threads.list.v1",
        )!;
        const start = commands.find((command) => command.command === "codex.terminal.start.v1")!;
        let otherHomeExits = 0;
        const unsubscribe = subscribeCodexCatalogEvents(codexCatalogHomeId(otherHome), () => {}, {
          onTerminalExit: () => {
            otherHomeExits += 1;
          },
        });
        const day = path.join(home, "sessions", "2026", "10", "20");
        await fs.mkdir(day, { recursive: true });
        const oldId = randomUUID();
        const newId = randomUUID();
        const timestamp = "2026-10-20T10:00:00.000Z";
        // Synthetic rollout input is consumed by the real native app-server and file scanner.
        const rollout = (id: string, message: string) =>
          [
            {
              timestamp,
              type: "session_meta",
              payload: {
                id,
                timestamp,
                cwd: home,
                source: "cli",
                originator: "codex_cli_rs",
                cli_version: "0.162.1",
                model_provider: "openai",
              },
            },
            {
              timestamp,
              type: "event_msg",
              payload: { type: "user_message", message, images: [], local_images: [] },
            },
          ]
            .map((record) => JSON.stringify(record) + "\n")
            .join("");
        const abort = new AbortController();
        let terminal: Promise<string | undefined> | undefined;
        try {
          await fs.writeFile(
            path.join(day, `rollout-2026-10-20T10-00-00-${oldId}.jsonl`),
            rollout(oldId, "Existing synthetic session"),
          );
          const source = await factory.forNode();
          console.info("Initializing the isolated native Codex catalog");
          await source.control.initialize();
          const before = JSON.parse((await list.handle("{}"))!);
          expect(before.sessions.map((session: { threadId: string }) => session.threadId)).toEqual([
            oldId,
          ]);
          const nativeBefore = await codexControlRequest(
            pluginConfig,
            "thread/list",
            { limit: 20, useStateDbOnly: false },
            { config, startOptions: runtime.start, authProfileId: null, isolated: true },
          );
          expect(nativeBefore.data.map((thread) => thread.id)).toContain(oldId);
          console.info("Warm native Codex catalog verified; starting the real terminal");
          let signalStarted!: () => void;
          const started = new Promise<void>((resolve) => {
            signalStarted = resolve;
          });
          terminal = start.handle(JSON.stringify({ cwd: home, cols: 80, rows: 24 }), {
            signal: abort.signal,
            onInput: () => {},
            emitChunk: async () => signalStarted(),
          });
          await Promise.race([
            started,
            terminal.then(() => {
              throw new Error("Native terminal exited before producing output");
            }),
          ]);
          await fs.writeFile(
            path.join(day, `rollout-2026-10-20T10-00-01-${newId}.jsonl`),
            rollout(newId, "New synthetic session created while the terminal is open"),
          );
          abort.abort();
          await terminal;
          console.info("Native Codex terminal exited; checking new-session discovery");
          const nativeAfter = await codexControlRequest(
            pluginConfig,
            "thread/list",
            { limit: 20, useStateDbOnly: false },
            { config, startOptions: runtime.start, authProfileId: null, isolated: true },
          );
          expect(nativeAfter.data.map((thread) => thread.id)).toContain(newId);
          const after = JSON.parse((await list.handle("{}"))!);
          expect(after.sessions.map((session: { threadId: string }) => session.threadId)).toContain(
            newId,
          );
          expect(otherHomeExits).toBe(0);
        } finally {
          abort.abort();
          try {
            await terminal;
          } finally {
            unsubscribe();
            await factory.disconnect();
            await factory.stop();
          }
        }
      },
    );
  },
  120_000,
);

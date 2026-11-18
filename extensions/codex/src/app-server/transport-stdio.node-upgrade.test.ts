import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
import { createStdioTransport } from "./transport-stdio.js";

// openclaw-test-isolation: Process registration has separate lifecycle coverage;
// this regression runs the real child and observes its spawn errors and output.
vi.mock(import("./transport-process-registration.js"), async (importOriginal) => ({
  ...(await importOriginal()),
  prepareCodexAppServerProcessRegistration: async () => async (child: NodeJS.EventEmitter) => {
    await once(child, "spawn");
  },
}));

it.runIf(process.platform !== "win32")(
  "starts a managed launcher after Homebrew removes the running Node executable",
  async () => {
    await withTempDir("codex-node-upgrade-", async (root) => {
      const original = Object.getOwnPropertyDescriptor(process, "execPath")!;
      const oldNode = path.join(root, "Cellar/node/26.12.0/bin/node");
      const stableNode = path.join(root, "opt/node/bin/node");
      const launcher = path.join(root, "codex.mjs");
      await fs.mkdir(path.dirname(oldNode), { recursive: true });
      await fs.mkdir(path.dirname(stableNode), { recursive: true });
      await fs.symlink(process.execPath, oldNode);
      await fs.symlink(process.execPath, stableNode);
      await fs.writeFile(
        launcher,
        "console.log(JSON.stringify({ args: process.argv.slice(2), marker: process.env.MARKER, path: process.env.PATH, nodePath: process.env.NODE_PATH, preload: process.env.LD_PRELOAD }));",
      );
      try {
        Object.defineProperty(process, "execPath", { ...original, value: oldNode });
        await fs.unlink(oldNode);
        let output = "";
        let closed: Promise<unknown[]> | undefined;
        await createStdioTransport(
          {
            transport: "stdio",
            command: launcher,
            commandSource: "resolved-managed",
            args: ["app-server", "--listen", "stdio://"],
            headers: {},
            env: {
              MARKER: "recovered",
              NODE_PATH: "/unrelated/modules",
              LD_PRELOAD: "/unrelated/inject",
            },
            clearEnv: ["PATH"],
          },
          { PATH: "/unrelated/runtime" },
          undefined,
          (child) => {
            child.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
            // Observe close without turning a spawn error into an unhandled rejection.
            closed = new Promise((resolve) => {
              child.once("close", (...args) => resolve(args));
            });
          },
        );
        await expect(closed).resolves.toEqual([0, null]);
        expect(JSON.parse(output)).toEqual({
          args: ["app-server", "--listen", "stdio://"],
          marker: "recovered",
        });
      } finally {
        Object.defineProperty(process, "execPath", original);
      }
    });
  },
);

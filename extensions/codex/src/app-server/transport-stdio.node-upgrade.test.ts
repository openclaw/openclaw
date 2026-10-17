import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveTestNodeExecPath,
  stopChildProcess,
  withTempDir,
} from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
import { createStdioTransport } from "./transport-stdio.js";

// mock-isolation: Keep this spawn regression out of the durable process registry; lifecycle coverage is separate.
vi.mock("./transport-process-registration.js", () => ({
  prepareCodexAppServerProcessRegistration: async () => async () => {},
}));

it.skipIf(process.platform === "win32")(
  "starts a managed launcher after Homebrew removes the running Node keg without using PATH",
  async () => {
    const node = resolveTestNodeExecPath();
    const originalExecPath = Object.getOwnPropertyDescriptor(process, "execPath")!;
    await withTempDir("codex-node-upgrade-", async (root) => {
      const oldNode = path.join(root, "Cellar", "node", "26.1.0", "bin", "node");
      const stableNode = path.join(root, "opt", "node", "bin", "node");
      const launcher = path.join(root, "launcher.mjs");
      for (const executable of [oldNode, stableNode]) {
        await fs.mkdir(path.dirname(executable), { recursive: true });
        await fs.symlink(node, executable);
      }
      await fs.writeFile(
        launcher,
        "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), marker: process.env.MARKER }));",
      );
      await fs.unlink(oldNode);
      let child: ChildProcessWithoutNullStreams | undefined;
      try {
        Object.defineProperty(process, "execPath", { ...originalExecPath, value: oldNode });
        let output = "";
        let closed: Promise<unknown[]> | undefined;
        child = await createStdioTransport(
          {
            transport: "stdio",
            command: launcher,
            commandSource: "resolved-managed",
            args: ["app-server", "--listen", "stdio://"],
            headers: {},
            env: { MARKER: "managed-launch" },
            clearEnv: ["PATH"],
          },
          { PATH: "/unrelated/node/bin" },
          undefined,
          (spawned) => {
            spawned.stdout.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
            closed = once(spawned, "close");
          },
        );
        await expect(closed).resolves.toEqual([0, null]);
        expect(JSON.parse(output)).toEqual({
          args: ["app-server", "--listen", "stdio://"],
          marker: "managed-launch",
        });
      } finally {
        Object.defineProperty(process, "execPath", originalExecPath);
        if (child) {
          await stopChildProcess(child, 1_000);
        }
      }
    });
  },
);

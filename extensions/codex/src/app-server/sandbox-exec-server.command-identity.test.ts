import { useIsolatedStateGuard } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { sandboxExecServerRegistry } from "./sandbox-exec-server-registry.js";
import { ensureCodexSandboxExecServerEnvironment } from "./sandbox-exec-server.js";
import {
  createClient,
  createSandboxContext,
  execServerUrlFromClient,
  openSocket,
  readUntilClosed,
  rpc,
} from "./sandbox-exec-server.test-helpers.js";

useIsolatedStateGuard();

afterEach(async () => {
  await sandboxExecServerRegistry.closeAll();
});

describe("Codex sandbox command identity", () => {
  it.runIf(process.platform !== "win32")(
    "preserves literal argv process identity and exit status through a shell backend",
    async () => {
      const sandbox = createSandboxContext({
        buildExecSpec: async ({ command, env }) => ({
          argv: [
            "/bin/sh",
            "-c",
            // Prevent implicit shell exec optimization, which otherwise hides the extra process.
            `export BACKEND_EXEC_PID=$$; trap 'printf "BACKEND_EXIT\\n"; exit 99' EXIT; ${command}`,
          ],
          env: { ...env, PATH: process.env.PATH },
          stdinMode: "pipe-closed",
        }),
      });
      const client = createClient();
      await ensureCodexSandboxExecServerEnvironment({ client: client as never, sandbox });
      const socket = await openSocket(execServerUrlFromClient(client));
      try {
        await rpc(socket, "initialize", { clientName: "command-identity-test" });
        socket.send(JSON.stringify({ method: "initialized" }));
        await rpc(socket, "process/start", {
          processId: "literal-command",
          argv: [
            process.execPath,
            "-e",
            "console.log(process.pid + ':' + process.env.BACKEND_EXEC_PID); process.exit(42)",
          ],
          cwd: "file:///workspace",
          env: {},
          tty: false,
        });
        const read = await readUntilClosed(socket, "literal-command");
        expect(read).toMatchObject({ exited: true, closed: true, exitCode: 42 });
        const output = (read.chunks ?? [])
          .map(({ chunk }) => Buffer.from(chunk, "base64").toString("utf8"))
          .join("");
        expect(output).toMatch(/^\d+:\d+\n$/u);
        const [pid, backendPid] = output.trim().split(":").map(Number);
        expect(pid).toBeGreaterThan(0);
        expect(pid).toBe(backendPid);
      } finally {
        socket.close();
      }
    },
  );
});

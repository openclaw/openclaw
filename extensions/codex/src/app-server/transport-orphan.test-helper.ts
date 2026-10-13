import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export type OrphanFixtureStart = {
  kind: "start";
  stateDir: string;
  env: NodeJS.ProcessEnv;
} & ({ mode: "fixture" } | { mode: "native"; command: string; cwd: string });
export type OrphanFixtureRequest = OrphanFixtureStart | { kind: "close"; child: number };
export type OrphanFixtureTree = { parent: number; child: number; descendant: number };

const fixture = fileURLToPath(import.meta.url);
const children = new Map<number, ChildProcessWithoutNullStreams>();
async function startTree(request: OrphanFixtureStart): Promise<OrphanFixtureTree> {
  const { createStdioTransport } = await import("./transport-stdio.js");
  const native = request.mode === "native";
  const child = await createStdioTransport(
    {
      transport: "stdio",
      command: request.mode === "native" ? request.command : process.execPath,
      args: native ? ["app-server", "--listen", "stdio://"] : ["--import", "tsx", fixture, "child"],
      cwd: request.mode === "native" ? request.cwd : undefined,
      headers: {},
    },
    request.env,
  );
  children.set(child.pid!, child);
  child.stderr.pipe(process.stderr);
  return await new Promise<OrphanFixtureTree>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => reject(new Error("Fixture child exited before readiness")));
    const send = (message: object) => child.stdin.write(`${JSON.stringify(message)}\n`);
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (!native) {
        resolve({ parent: process.pid, ...JSON.parse(line) });
        return;
      }
      // SAFETY: The pinned native test binary emits Codex JSON-RPC envelopes on stdout.
      const message = JSON.parse(line) as {
        id?: number;
        method?: string;
        error?: unknown;
        params: { deltaBase64: string };
      };
      if (message.error) {
        reject(new Error(JSON.stringify(message.error)));
      } else if (message.id === 1) {
        send({ method: "initialized", params: {} });
        send({
          id: 2,
          method: "command/exec",
          params: {
            command: [
              process.execPath,
              "-e",
              "process.stdout.write(String(process.pid)+'\\n');setInterval(()=>{},1000)",
            ],
            processId: "orphan-proof",
            streamStdoutStderr: true,
            disableTimeout: true,
            sandboxPolicy: { type: "dangerFullAccess" },
            cwd: request.mode === "native" ? request.cwd : undefined,
          },
        });
      } else if (message.method === "command/exec/outputDelta") {
        const descendant = Number(
          Buffer.from(message.params.deltaBase64, "base64").toString().trim(),
        );
        if (Number.isSafeInteger(descendant) && descendant > 0) {
          resolve({ parent: process.pid, child: child.pid!, descendant });
        }
      }
    });
    if (native) {
      send({
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "openclaw_orphan_test", version: "1.0.0" },
          capabilities: { experimentalApi: true },
        },
      });
    }
  });
}

if (process.argv[2] === "child") {
  const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  process.stdout.write(`${JSON.stringify({ child: process.pid, descendant: descendant.pid })}\n`);
  process.stdin.resume();
  setInterval(() => {}, 1000);
} else {
  let pending = Promise.resolve();
  process.on("message", (request: OrphanFixtureRequest) => {
    pending = pending.then(async () => {
      try {
        if (request.kind === "close") {
          const child = children.get(request.child);
          if (!child) {
            throw new Error("Unknown fixture child");
          }
          const { closeCodexAppServerTransportAndWait } = await import("./transport.js");
          const closed = await closeCodexAppServerTransportAndWait(child);
          if (!closed.exited) {
            throw new Error("Fixture child did not exit");
          }
          children.delete(request.child);
          process.send!("closed");
        } else {
          // Registration captures each store's environment; starts must remain serial.
          process.env.OPENCLAW_STATE_DIR = request.stateDir;
          process.env.PATH = request.env.PATH;
          process.send!(await startTree(request));
        }
      } catch (error) {
        process.send!({ error: error instanceof Error ? error.message : String(error) });
      }
    });
  });
}

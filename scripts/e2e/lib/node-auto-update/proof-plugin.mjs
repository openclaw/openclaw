// A fixed workload exercises the public node-command lifecycle without a shell surface.
import fs from "node:fs";
import path from "node:path";

export function createNodeUpdateProofPlugin(root, { legacy = false } = {}) {
  const id = "node-update-proof";
  const command = "proof.update.work";
  const directory = path.join(root, id);
  // Plugin modules run from captured generations; synchronization stays in the proof owner.
  const workerPath = path.join(directory, "worker.mjs");
  const busyPath = path.join(root, "busy.started");
  const releasePath = path.join(root, "busy.release");
  fs.mkdirSync(directory);
  const writeJson = (name, value) => {
    fs.writeFileSync(path.join(directory, name), `${JSON.stringify(value, null, 2)}\n`);
  };
  writeJson("package.json", {
    name: "@openclaw-test/node-update-proof",
    version: "1.0.0",
    type: "module",
    openclaw: { extensions: ["./index.mjs"] },
  });
  writeJson("openclaw.plugin.json", {
    id,
    name: "Node update proof",
    categories: ["developer-tools"],
    activation: { onStartup: true },
    configSchema: { type: "object", additionalProperties: false, properties: {} },
  });
  fs.writeFileSync(
    workerPath,
    `
import fs from "node:fs";
const action = process.argv[2];
if (action === "ping") {
  console.log(JSON.stringify({ marker: "NODE_UPDATE_PING_OK", pid: process.pid }));
} else if (action === "hold") {
  fs.writeFileSync(${JSON.stringify(busyPath)}, String(process.pid));
  const timer = setInterval(() => {
    if (fs.existsSync(${JSON.stringify(releasePath)})) {
      clearInterval(timer);
      console.log(JSON.stringify({ marker: "NODE_UPDATE_HOLD_COMPLETED", pid: process.pid }));
    }
  }, 100);
} else {
  throw new Error("Unknown fixed workload action");
}
`,
  );
  fs.writeFileSync(
    path.join(directory, "index.mjs"),
    `
import { spawn } from "node:child_process";
const active = new Set();
export default {
  id: ${JSON.stringify(id)},
  register(api) {
    api.registerNodeHostCommand({
      command: ${JSON.stringify(command)}, cap: "proof-update",
      ${legacy ? "" : "hasActiveWork: () => active.size > 0,"}
      async onDisconnect() {
        for (const run of active) run.child.kill("SIGTERM");
        await Promise.allSettled([...active].map((run) => run.done));
      },
      async handle(paramsJSON, _io, context) {
        const params = JSON.parse(paramsJSON ?? "{}");
        if (!params || typeof params !== "object" || Object.keys(params).length !== 1 ||
            (params.action !== "hold" && params.action !== "ping")) {
          throw new Error("Expected exactly one fixed action: hold or ping");
        }
        api.logger.info("[node-update-proof] handler action=" + params.action);
        const authorize = context?.prepareExecAuthorization?.("session-full");
        if (!authorize) throw new Error("Node execution authorization is unavailable");
        authorize();
        api.logger.info("[node-update-proof] authorized action=" + params.action);
        const child = spawn(process.execPath, [${JSON.stringify(workerPath)}, params.action], {
          env: {}, stdio: ["ignore", "pipe", "pipe"],
        });
        api.logger.info("[node-update-proof] child action=" + params.action + " pid=" + child.pid);
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
        child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
        const done = new Promise((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) => {
            api.logger.info("[node-update-proof] child-exit action=" + params.action + " code=" + code + " signal=" + signal);
            if (code === 0) resolve(stdout.trim());
            else reject(new Error("Fixed workload failed: " + (signal ?? code) + " " + stderr));
          });
        });
        const run = { child, done };
        active.add(run);
        const abort = () => child.kill("SIGTERM");
        context.signal?.addEventListener("abort", abort, { once: true });
        if (context.signal?.aborted) abort();
        const cleanup = () => {
          context.signal?.removeEventListener("abort", abort);
          active.delete(run);
        };
        void done.then(cleanup, cleanup);
        if (${legacy} && params.action === "hold") {
          return JSON.stringify({
            marker: "NODE_UPDATE_HOLD_STARTED", pid: child.pid,
            hostPid: process.pid, hostArgv: [...process.argv],
          });
        }
        const workload = JSON.parse(await done);
        return JSON.stringify({ ...workload, hostPid: process.pid, hostArgv: [...process.argv] });
      },
    });
  },
};
`,
  );
  return {
    command,
    busyPath,
    releasePath,
    plugins: {
      enabled: true,
      allow: [id],
      load: { paths: [directory] },
      entries: { [id]: { enabled: true } },
    },
  };
}

import type { ResolvedOpenShellPluginConfig } from "./config.js";

export function createOpenShellWorkerNodeConfig(
  worker: NonNullable<ResolvedOpenShellPluginConfig["worker"]>,
) {
  const { provider, credentialEnv, api, baseUrl, ...model } = worker.model;
  return {
    models: {
      providers: {
        [provider]: {
          api,
          baseUrl,
          apiKey: "${" + credentialEnv + "}",
          models: [
            {
              ...model,
              name: model.id,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
    nodeHost: { workerRuns: { enabled: true, isolation: "none" } },
    ...(worker.agentWorkspace
      ? {
          agents: {
            defaults: { workspace: worker.agentWorkspace.remoteRoot, skipBootstrap: true },
            entries: {
              [worker.agentWorkspace.agentId]: { workspace: worker.agentWorkspace.remoteRoot },
            },
          },
          plugins: { allow: ["file-transfer"], entries: { "file-transfer": { enabled: true } } },
        }
      : {}),
  };
}

// Run on the node before enrollment or binding; never seed or replace remote documents.
export const OPEN_SHELL_AGENT_WORKSPACE_CHECK = String.raw`(root, stateDir) => {
  const fs = require("node:fs");
  const path = require("node:path");
  const state = path.resolve(stateDir);
  if (root === state || root.startsWith(state + "/") || state.startsWith(root + "/")) {
    throw new Error("Agent workspace must be separate from private node state");
  }
  let stat;
  try { stat = fs.statSync(root); } catch {
    throw new Error("Prepare the canonical agent workspace directory in this sandbox before starting or configuring its worker; setup never copies or seeds agent files");
  }
  if (!stat.isDirectory() || fs.realpathSync(root) !== root || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
    throw new Error("Canonical agent workspace must be a private directory owned by the node user without symlink aliases");
  }
  fs.accessSync(root, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
}`;

// Executed by the image's Node inside OpenShell, not by the Gateway. The only
// secret input is a one-shot pairing handoff on stdin; it never enters argv.
export const OPEN_SHELL_WORKER_BOOTSTRAP = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
process.umask(0o077);
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  input += chunk;
  if (Buffer.byteLength(input) > 131072) {
    console.error("OpenShell worker bootstrap input is too large");
    process.exit(1);
  }
});
process.stdin.on("end", () => {
  try {
    const { worker, config, target } = JSON.parse(input);
    input = "";
    const credential = process.env[worker.model.credentialEnv];
    if (!credential || !credential.startsWith("openshell:resolve:env:")) {
      throw new Error("OpenShell did not provide a broker placeholder for the configured credential environment; refusing worker startup");
    }
    if (worker.agentWorkspace) {
      (${OPEN_SHELL_AGENT_WORKSPACE_CHECK})(worker.agentWorkspace.remoteRoot, worker.stateDir);
    }
    const stateDir = path.resolve(worker.stateDir);
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    if (fs.realpathSync(stateDir) !== stateDir) {
      throw new Error("OpenShell worker state directory must not contain symlinks");
    }
    const stat = fs.statSync(stateDir);
    if ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) {
      throw new Error("OpenShell worker state directory must be private and owned by the node user");
    }
    const configPath = path.join(stateDir, "openclaw.json");
    try {
      fs.writeFileSync(configPath, JSON.stringify(config), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = fs.lstatSync(configPath);
      if (!existing.isFile() || existing.isSymbolicLink() || (existing.mode & 0o077) !== 0 ||
          JSON.stringify(JSON.parse(fs.readFileSync(configPath, "utf8"))) !== JSON.stringify(config)) {
        throw new Error("OpenShell worker configuration already exists with different content or unsafe permissions; preserve the existing node and use another private stateDir");
      }
    }
    const env = {};
    for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "TZ", "NODE_EXTRA_CA_CERTS", "NODE_USE_SYSTEM_CA"]) {
      if (process.env[key]) env[key] = process.env[key];
    }
    // Node does not consume OpenShell's OpenSSL CA variable by itself.
    if (!env.NODE_EXTRA_CA_CERTS && process.env.SSL_CERT_FILE) {
      env.NODE_EXTRA_CA_CERTS = process.env.SSL_CERT_FILE;
    }
    env[worker.model.credentialEnv] = credential;
    env.OPENCLAW_STATE_DIR = stateDir;
    env.OPENCLAW_CONFIG_PATH = configPath;
    let targetPath;
    let args = ["node", "run", "--session-host"];
    if (target) {
      targetPath = path.join(stateDir, "pairing-target");
      fs.writeFileSync(targetPath, target, { flag: "wx", mode: 0o600 });
      args = ["connect", "--target-file", targetPath, "--session-host"];
    }
    const child = spawn(worker.nodeCommand, args, { env, stdio: "inherit" });
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
    const cleanup = () => {
      if (targetPath) {
        try { fs.unlinkSync(targetPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    };
    child.on("error", () => {
      cleanup();
      console.error("OpenShell worker could not start the configured OpenClaw executable");
      process.exitCode = 1;
    });
    child.on("exit", (code, signal) => {
      cleanup();
      process.exitCode = code ?? (signal ? 1 : 0);
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
});
`;

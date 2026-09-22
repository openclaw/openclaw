// This module must run on unsupported Node versions, before importing dist or dependencies.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { isUsableNode, resolveRecoveryPath } from "./node-runtime-recovery.mjs";

function canInstallPrivateNode() {
  if (!["x64", "arm64"].includes(process.arch)) {
    return false;
  }
  if (process.platform === "linux") {
    // The existing Alpine installer uses apk/sudo; private CLI recovery must not.
    return Boolean(process.report?.getReport().header.glibcVersionRuntime);
  }
  return process.platform === "darwin" || process.platform === "win32";
}

function confirmNodeUpdate() {
  return new Promise((resolve) => {
    const prompt = createInterface({ input: process.stdin, output: process.stderr });
    let settled = false;
    const finish = (answer) => {
      if (settled) {
        return;
      }
      settled = true;
      prompt.close();
      resolve(/^(y|yes)$/i.test(answer.trim()));
    };
    prompt.once("close", () => finish(""));
    prompt.once("SIGINT", () => finish(""));
    prompt.question("Update NodeJS: Y/N [N]: ", finish);
  });
}

/** Returns a verified private runtime, or null when recovery was declined/unavailable. */
export async function resolveUpdatedNodeRuntime(
  recoveryRoot,
  { allowInstall = true, env = process.env } = {},
) {
  if (env.OPENCLAW_NODE_UPDATE_RESPAWNED === "1") {
    return null;
  }
  const privatePaths = { allowMissing: true, trustedRoot: recoveryRoot };
  const prefix = resolveRecoveryPath(
    path.join(recoveryRoot, "tools", "cli-node"),
    undefined,
    privatePaths,
  );
  const nodeRoot =
    prefix && resolveRecoveryPath(path.join(prefix, "tools", "node"), undefined, privatePaths);
  if (!prefix || !nodeRoot) {
    return null;
  }
  const nodePath =
    process.platform === "win32"
      ? path.join(nodeRoot, "node.exe")
      : path.join(nodeRoot, "bin", "node");

  // An earlier explicit opt-in is durable, but an incompatible cache is never trusted.
  if (isUsableNode(nodePath, { env, trustedRoot: recoveryRoot })) {
    return nodePath;
  }
  if (
    !allowInstall ||
    !process.stdin.isTTY ||
    !process.stderr.isTTY ||
    env.CI ||
    process.argv.some((arg) => ["--non-interactive", "--json", "--yes"].includes(arg)) ||
    !canInstallPrivateNode()
  ) {
    return null;
  }

  process.stderr.write(
    "Install a compatible Node.js for OpenClaw only and retry this command.\n" +
      "The Node.js installation will not change system Node.js, shell settings, or Gateway services.\n",
  );
  if (!(await confirmNodeUpdate())) {
    return null;
  }

  const windows = process.platform === "win32";
  const installer = fileURLToPath(
    new URL(windows ? "./scripts/install.ps1" : "./scripts/install-cli.sh", import.meta.url),
  );
  const command = windows
    ? (await import("./scripts/windows-cmd-helpers.mjs")).resolveWindowsPowerShellPath(env)
    : process.platform === "darwin"
      ? "/bin/bash"
      : "bash";
  const args = windows
    ? [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        installer,
        "-NodeOnly",
        "-NodePrefix",
        nodeRoot,
      ]
    : [installer, "--node-only", "--prefix", prefix];
  const result = spawnSync(command, args, { stdio: "inherit", env });
  if (result.status !== 0 || !isUsableNode(nodePath, { env, trustedRoot: recoveryRoot })) {
    process.stderr.write(
      "openclaw: Node.js update failed; install a compatible Node.js manually.\n",
    );
    return null;
  }
  process.stderr.write("openclaw: Node.js updated. Retrying your command.\n");
  return nodePath;
}

#!/usr/bin/env node
// The target checkout is data until it enters this disposable, secretless container.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const image =
  "docker.io/library/node:24.22.1-bookworm@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a";
const [sourceArgument, toolingArgument, outputArgument, packageDir] = process.argv.slice(2);
if (process.argv.length !== 6 || !/^extensions\/[a-z0-9][a-z0-9._-]*$/.test(packageDir ?? "")) {
  throw new Error(
    "usage: plugin-clawhub-pack-isolated.mjs <source> <tooling> <output> extensions/<plugin>",
  );
}
const source = realpathSync(sourceArgument);
const tooling = realpathSync(toolingArgument);
mkdirSync(outputArgument, { recursive: true });
const output = realpathSync(outputArgument);
if (readdirSync(output).length !== 0) {
  throw new Error("Pack output directory must be empty");
}
// --mount has its own comma-delimited grammar, separate from shell argv quoting.
for (const directory of [source, tooling, output]) {
  if (directory.includes(",") || directory.includes("\n")) {
    throw new Error("Container mount paths must not contain commas or newlines");
  }
}
const container = process.env.PACK_CONTAINER_NAME ?? "clawhub-pack-" + randomUUID();
if (!/^clawhub-pack-[a-z0-9][a-z0-9-]{0,100}$/.test(container) || container.trim() !== container) {
  throw new Error(
    "PACK_CONTAINER_NAME must be a clawhub-pack- name with lowercase letters, digits or hyphens (at most 114 characters)",
  );
}
const maxArtifactBytes = 1024 * 1024 * 1024;
const config = mkdtempSync(path.join(tmpdir(), "clawhub-docker-config-"));
const dockerEnv = { PATH: process.env.PATH };
let packFailure;
try {
  const args = [
    "--config",
    config,
    "run",
    "--name",
    container,
    "--rm",
    "--pull=never",
    // Patched npm dependencies need registry access. Never use host networking;
    // the runner must have no privileged unauthenticated internal/metadata APIs.
    "--network=bridge",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user",
    process.getuid() + ":" + process.getgid(),
    "--pids-limit=256",
    "--memory=8g",
    "--cpus=4",
    // Bound each file written by target scripts, including the exported tarball.
    // This is not a quota on aggregate output-directory writes.
    "--ulimit",
    "fsize=" + maxArtifactBytes + ":" + maxArtifactBytes,
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,mode=1777,size=1g",
    "--tmpfs",
    "/work:rw,nosuid,nodev,mode=1777,size=4g",
    "--mount",
    "type=bind,src=" + source + ",dst=/source-input,readonly",
    "--mount",
    "type=bind,src=" + output + ",dst=/output",
  ];
  // The source bind includes .git; its private writable copy removes it below.
  // Tooling mounts exclude .git, npm config, runner files and caches. Only
  // trusted build inputs and the preinstalled CLI/dependency trees are exposed.
  for (const entry of [
    "scripts",
    "src",
    "packages",
    "extensions",
    "patches",
    "node_modules",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    ".clawhub-cli",
  ]) {
    args.push(
      "--mount",
      "type=bind,src=" + tooling + "/" + entry + ",dst=/tooling/" + entry + ",readonly",
    );
  }
  for (const key of ["SOURCE_REPO", "SOURCE_COMMIT", "SOURCE_REF", "PACKAGE_TAG"]) {
    if (!process.env[key]) {
      throw new Error(key + " is required");
    }
    args.push("--env", key + "=" + process.env[key]);
  }
  const script = [
    "mkdir -p /work/source /tmp/home",
    "cp -a /source-input/. /work/source/",
    "cd /work/source",
    "rm -rf .git node_modules",
    "chmod -R u+rwX .",
    "ln -s /tooling/node_modules node_modules",
    "for extension in extensions/*; do",
    '  if [[ -d "$extension" && ! -L "$extension" ]]; then',
    '    rm -rf "$extension/node_modules"',
    '    if [[ -d "/tooling/$extension/node_modules" ]]; then',
    '      ln -s "/tooling/$extension/node_modules" "$extension/node_modules"',
    "    fi",
    "  fi",
    "done",
    // No runner/OIDC/token/command-file environment reaches target asset scripts.
    // The absolute CLI keeps pack '.' in the manifest owner's staged cwd.
    "exec env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp/home TMPDIR=/tmp" +
      ' SOURCE_REPO="$SOURCE_REPO" SOURCE_COMMIT="$SOURCE_COMMIT"' +
      ' SOURCE_REF="$SOURCE_REF" PACKAGE_TAG="$PACKAGE_TAG"' +
      " OPENCLAW_CLAWHUB_CLI=/tooling/.clawhub-cli/node_modules/.bin/clawhub" +
      " OPENCLAW_CLAWHUB_PACK_OUTPUT_DIR=/output" +
      ' bash /tooling/scripts/plugin-clawhub-publish.sh --pack "$1" --metadata-root /tooling',
  ].join("\n");
  args.push(
    "--workdir",
    "/work",
    "--entrypoint",
    "/bin/bash",
    image,
    "-euc",
    script,
    "clawhub-isolated-pack",
    packageDir,
  );
  // Never inherit Docker credentials/config or pass through target-controlled
  // output as GitHub workflow commands. The container receives no host socket.
  const result = spawnSync("docker", args, {
    env: dockerEnv,
    encoding: "utf8",
    timeout: 15 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
    killSignal: "SIGKILL",
  });
  for (const text of [result.stdout, result.stderr]) {
    for (const line of (text ?? "").split("\n")) {
      if (line) {
        process.stdout.write("[isolated pack] " + JSON.stringify(line) + "\n");
      }
    }
  }
  if (result.error) {
    throw result.error;
  }
  process.exitCode = result.status ?? 1;
} catch (error) {
  packFailure = error;
}
{
  // Killing the client on timeout does not necessarily stop the container.
  const removed = spawnSync("docker", ["--config", config, "rm", "--force", container], {
    env: dockerEnv,
    encoding: "utf8",
    timeout: 30_000,
  });
  rmSync(config, { recursive: true, force: true });
  if (removed.error || (removed.status !== 0 && !removed.stderr.includes("No such container"))) {
    packFailure = new AggregateError(
      packFailure ? [packFailure] : [],
      "Unable to confirm isolated pack container removal",
    );
  }
}
if (packFailure) {
  throw packFailure instanceof Error
    ? packFailure
    : new Error("Isolated pack failed", { cause: packFailure });
}
if (!process.exitCode) {
  const artifacts = readdirSync(output);
  if (
    artifacts.length !== 1 ||
    !artifacts[0].endsWith(".tgz") ||
    !lstatSync(path.join(output, artifacts[0])).isFile()
  ) {
    throw new Error("Isolated pack must produce exactly one regular .tgz file (no symlinks)");
  }
  if (lstatSync(path.join(output, artifacts[0])).size > maxArtifactBytes) {
    throw new Error("Isolated pack .tgz artifacts must total at most 1 GiB");
  }
}

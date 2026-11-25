import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runManagedCommand, terminateManagedChild } from "../../../lib/managed-child-process.mts";
import {
  classifyReleaseTrain,
  compareReleaseVersions,
  parseReleaseVersion,
} from "../../../lib/release-version.mjs";

const extended = (version) => {
  const parsed = parseReleaseVersion(version);
  return parsed !== null && classifyReleaseTrain(parsed) === "extended-stable";
};

export function publishedDriverFixtureVersion(candidateVersion, driverVersion) {
  const comparison = compareReleaseVersions(candidateVersion, driverVersion);
  if (comparison <= 0 && extended(driverVersion)) {
    // Selector updates skip an already-installed version. Keep this synthetic
    // relabel on the same release train while forcing an actual byte replacement.
    const driver = parseReleaseVersion(driverVersion);
    return `${driver.year}.${driver.month}.${driver.patch + 1}`;
  }
  return comparison < 0 ? driverVersion : candidateVersion;
}

// Keep the published updater's channel policy intact. Only its registry I/O is
// replaced, through the shipped loopback seam, with the exact candidate archive.
/**
 * @template T
 * @param {{ fromVersion: string, toVersion: string, tarball: string, env: NodeJS.ProcessEnv, runtime: string, signal?: AbortSignal, timeoutMs: number, extra?: string[], run: (args: string[], env: NodeJS.ProcessEnv) => T | Promise<T> }} options
 * @returns {Promise<T>}
 */
export async function withPublishedDriverUpdate({
  fromVersion,
  toVersion,
  tarball,
  env,
  runtime,
  signal,
  timeoutMs,
  extra = [],
  run,
}) {
  const args = ["update", "--yes", "--json", ...extra];
  if (!extended(fromVersion) || !extended(toVersion)) {
    return run(
      [...args, "--tag", tarball, ...(extended(fromVersion) ? ["--channel", "stable"] : [])],
      env,
    );
  }

  const directory = fs.mkdtempSync(path.join(runtime, "candidate-registry-"));
  const log = fs.openSync(path.join(directory, "registry.log"), "w", 0o600);
  const ready = Promise.withResolvers();
  let child;
  const registry = runManagedCommand({
    bin: process.execPath,
    args: [
      fileURLToPath(new URL("../plugins/npm-registry-server.mjs", import.meta.url)),
      path.join(directory, "port"),
      "openclaw",
      toVersion,
      tarball,
    ],
    env: {
      ...env,
      OPENCLAW_NPM_REGISTRY_UPSTREAM: "https://registry.npmjs.org",
      OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_URL: "",
      OPENCLAW_NPM_REGISTRY_MERGE_UPSTREAM: "",
      OPENCLAW_NPM_REGISTRY_DIST_TAGS: "extended-stable=" + toVersion,
      OPENCLAW_NPM_REGISTRY_BIND_HOST: "127.0.0.1",
      OPENCLAW_NPM_REGISTRY_PORT: "0",
    },
    stdio: ["ignore", log, log, "ipc"],
    signal,
    timeoutMs,
    requireProcessTreeExit: true,
    onReady(process) {
      child = process;
      child.once("message", ready.resolve);
    },
  });
  void registry.then(
    () => ready.reject(new Error("Candidate registry exited before readiness")),
    ready.reject,
  );
  try {
    const port = await ready.promise;
    const registryUrl = "http://127.0.0.1:" + port;
    return await run(args, {
      ...env,
      OPENCLAW_UPDATE_PACKAGE_SPEC: "openclaw",
      npm_config_registry: registryUrl,
      NPM_CONFIG_REGISTRY: registryUrl,
    });
  } finally {
    if (child) {
      terminateManagedChild(child, "SIGTERM");
    }
    try {
      await registry;
    } finally {
      fs.closeSync(log);
    }
  }
}

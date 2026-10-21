#!/usr/bin/env node
// Reuse the Linux runtime build without transferring platform-specific dependencies.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";

// Upload completes before the Linux job's unrelated built-artifact checks.
// Wait only after Swift compilation; never allocate a second runtime builder.
export async function waitForNativeRuntime(revision, env = process.env) {
  assert.match(revision, /^[a-f0-9]{40}$/u, "Expected an exact checkout SHA");
  const { GITHUB_API_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT, GH_TOKEN } = env;
  assert.ok(GITHUB_API_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID && GITHUB_RUN_ATTEMPT && GH_TOKEN);
  const run = `/repos/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
  const request = async (route) => {
    const response = await fetch(`${GITHUB_API_URL}${route}`, {
      headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(30_000),
    });
    assert.ok(response.ok, `Native runtime lookup failed: HTTP ${response.status}`);
    return response.json();
  };
  const artifactForAttempt = async (attempt) => {
    const name = `macos-native-runtime-${revision}-${attempt}`;
    const { artifacts } = await request(`${run}/artifacts?name=${name}&per_page=100`);
    const matches = artifacts.filter((artifact) => artifact.name === name);
    if (!matches.length) {
      return undefined;
    }
    assert.equal(matches.length, 1, "Expected one native runtime artifact");
    assert.equal(matches[0].expired, false, "Native runtime artifact expired");
    return String(matches[0].id);
  };
  console.error(`Waiting for native runtime ${revision} in run ${GITHUB_RUN_ID}`);
  // The enclosing job retains its original deadline, including this wait.
  for (;;) {
    const artifactId = await artifactForAttempt(GITHUB_RUN_ATTEMPT);
    if (artifactId) {
      return artifactId;
    }
    for (let page = 1; ; page++) {
      const { jobs } = await request(`${run}/jobs?filter=latest&per_page=100&page=${page}`);
      const producer = jobs.find((job) => job.name === "build-artifacts");
      if (producer) {
        // Rerunning only failed jobs retains the successful producer's earlier output.
        if (
          producer.conclusion === "success" &&
          producer.run_attempt < Number(GITHUB_RUN_ATTEMPT)
        ) {
          const retainedId = await artifactForAttempt(producer.run_attempt);
          assert.ok(retainedId, "Successful Linux build has no retained native runtime artifact");
          return retainedId;
        }
        assert.notEqual(
          producer.status,
          "completed",
          `Linux build finished without the native runtime (${producer.conclusion})`,
        );
        break;
      }
      if (jobs.length < 100) {
        break;
      }
    }
    await setTimeout(10_000);
  }
}

function verifyRevision(root, revision) {
  assert.match(revision, /^[a-f0-9]{40}$/u, "Expected an exact checkout SHA");
  const info = JSON.parse(fs.readFileSync(path.join(root, "dist/build-info.json"), "utf8"));
  assert.equal(info.commit, revision, "Native test runtime must match the selected checkout");
}

export function packNativeRuntime(root, directory, revision) {
  verifyRevision(root, revision);
  const entries = ["dist"];
  if (fs.existsSync(path.join(root, "dist-runtime"))) {
    entries.push("dist-runtime");
  }
  for (const entry of fs.readdirSync(path.join(root, "packages"), { withFileTypes: true })) {
    const dist = path.join("packages", entry.name, "dist");
    if (entry.isDirectory() && fs.existsSync(path.join(root, dist))) {
      entries.push(dist);
    }
  }
  fs.mkdirSync(directory, { recursive: true });
  // The policy CLI uses core workers, not UI, plugins, or the sealed remote-worker deployment.
  // tar preserves executable bits; native dependencies stay on their target platform.
  execFileSync(
    "tar",
    [
      "-czf",
      path.join(directory, "runtime.tgz"),
      "--exclude=dist/extensions",
      "--exclude=dist/control-ui",
      "--exclude=dist/worker",
      "--exclude=dist-runtime/extensions",
      ...entries.toSorted(),
    ],
    { cwd: root, stdio: "inherit" },
  );
}

export function restoreNativeRuntime(root, directory, revision) {
  execFileSync("tar", ["-xzf", path.join(directory, "runtime.tgz")], {
    cwd: root,
    stdio: "inherit",
  });
  verifyRevision(root, revision);
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const bin = path.join(directory, "bin");
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(bin, "openclaw"),
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(path.join(root, "openclaw.mjs"))} "$@"\n`,
    { mode: 0o700 },
  );
  return bin;
}

if (import.meta.main) {
  const [operation, target, revision, ...extra] = process.argv.slice(2);
  if (operation === "wait" && target && !revision) {
    process.stdout.write(`${await waitForNativeRuntime(target)}\n`);
  } else {
    if (!target || !revision || extra.length || !["pack", "restore"].includes(operation)) {
      throw new Error(
        "Usage: macos-native-runtime-artifact.mjs <pack|restore> <directory> <SHA> | wait <SHA>",
      );
    }
    const root = process.cwd();
    const directory = path.resolve(target);
    if (operation === "pack") {
      packNativeRuntime(root, directory, revision);
    } else {
      process.stdout.write(`${restoreNativeRuntime(root, directory, revision)}\n`);
    }
  }
}

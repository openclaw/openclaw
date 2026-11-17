/**
 * A/A/B manifest+staging proof using native Git and synthetic files only.
 * node --import ./scripts/tsx.mjs scripts/perf/github-base-refresh-measure.ts
 *   --fixture <new-directory> --mode prepare [--files 62000 --bytes 18000]
 * Save the parent's workspace-manifest-computation.runtime.ts, then run --mode compare
 * --baseline-runtime <saved-file> [--samples 5]. Each A arm executes that frozen owner
 * with the original two-checkout preparation. B executes the current owner. Includes
 * cleanup. Compare manifest bytes, build-cache inputs, and staged commit OIDs.
 * --representative adds renames, deletions, modes, symlinks, gitlinks, directory/file
 * replacements, excluded paths, build-cache inputs and a newline filename.
 * --census counts deleted spool/input files in a separate, untimed accounting run.
 * Allocation uses Node 26's V8 counter; native CPU uses a time -l Git wrapper on macOS.
 * Temporary file inventory counts exclude intermediate Git packs removed by the
 * checkout owner; payload bytes are logical, not device-level writes or btrfs PSI.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { requireGit } from "../../src/agents/worktrees/git.js";
import { prepareLocalWorkspaceCheckout } from "../../src/gateway/worker-environments/local-workspace-checkout.js";
import { readActualWorkspaceManifestImpl } from "../../src/gateway/worker-environments/workspace-actual-manifest.js";
import { executeWorkspaceManifestComputation } from "../../src/gateway/worker-environments/workspace-manifest-computation.runtime.js";
import { workerWorkspaceResultStaging } from "../../src/gateway/worker-environments/workspace-result-staging.js";
import { STAGED_INPUT_GITIGNORE, stagedInputDirectory } from "../../src/media/staged-inputs.js";
import { drainGlobalSingletonLifecycleState } from "../../src/shared/global-singleton.js";

const { values } = parseArgs({
  options: {
    fixture: { type: "string" },
    mode: { type: "string", default: "compare" },
    files: { type: "string", default: "62000" },
    bytes: { type: "string", default: "18000" },
    samples: { type: "string", default: "5" },
    "baseline-runtime": { type: "string" },
    changes: { type: "string", default: "10" },
    census: { type: "boolean" },
    representative: { type: "boolean" },
  },
});
assert(values.fixture);
const fixture = path.resolve(values.fixture);
const root = path.join(fixture, "source");
const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const git = (...args: string[]) =>
  requireGit(root, args, {
    timeoutMs: 300_000,
    env: { GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_SYSTEM: os.devNull },
  });
try {
  if (values.mode === "advance") {
    const shape = JSON.parse(await fs.readFile(path.join(fixture, "shape.json"), "utf8"));
    for (let index = 0; index < Number(values.changes); index++) {
      await fs.writeFile(
        path.join(root, `group-${Math.floor(index / 100)}/file-${index}.txt`),
        `Changed ${index}\n`,
      );
    }
    await git("commit", "--quiet", "-am", "Advance synthetic refresh");
    shape.afterTree = await git("rev-parse", "HEAD");
    await fs.writeFile(path.join(fixture, "shape.json"), JSON.stringify(shape));
    console.log(JSON.stringify(shape));
  } else if (values.mode === "prepare") {
    await fs.mkdir(fixture);
    await fs.mkdir(root);
    await git("init", "--quiet");
    await git("config", "user.name", "Synthetic Fixture");
    await git("config", "user.email", "fixture@example.test");
    const files = Number(values.files),
      bytes = Number(values.bytes);
    for (let index = 0; index < files; index++) {
      const file = `group-${Math.floor(index / 100)}/file-${index}.txt`;
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      const content = Buffer.alloc(bytes);
      for (let offset = 0; offset < bytes; offset += 32) {
        createHash("sha256").update(`synthetic:${index}:${offset}`).digest().copy(content, offset);
      }
      await fs.writeFile(path.join(root, file), content);
    }
    const write = async (file: string, text: string) => {
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), text);
    };
    const buildCacheInputs = values.representative ? [".artifacts/build-cache-inputs/kept"] : [];
    const stagedInputs = [
      stagedInputDirectory("a".repeat(64)),
      stagedInputDirectory("b".repeat(64)),
    ];
    if (values.representative) {
      for (const file of [
        "rename.txt",
        "remove.txt",
        "mode.sh",
        "dir-to-file/child",
        "file-to-dir",
        "line\nname.txt",
        ...buildCacheInputs,
      ]) {
        await write(file, `Synthetic ${file}\n`);
      }
      await write("excluded/node_modules/input", "derived");
      await fs.symlink("rename.txt", path.join(root, "link"));
      await fs.symlink("../outside", path.join(root, "escaping"));
      for (const [index, directory] of stagedInputs.entries()) {
        await write(`${directory}/.gitignore`, index === 0 ? STAGED_INPUT_GITIGNORE : "unowned\n");
        await write(`${directory}/node_modules/input`, "old input");
      }
    }
    await git("add", ".");
    if (values.representative) {
      await git("add", "--force", "--", ...stagedInputs);
    }
    await git("commit", "--quiet", "-m", "Synthetic source");
    const beforeTree = await git("rev-parse", "HEAD");
    const baseline = await readActualWorkspaceManifestImpl({ root, baseCommit: beforeTree });
    await fs.writeFile(path.join(fixture, "baseline.json"), baseline.rawManifest);
    for (let index = 0; index < Number(values.changes); index++) {
      await fs.writeFile(
        path.join(root, `group-${Math.floor(index / 100)}/file-${index}.txt`),
        `Changed ${index}\n`,
      );
    }
    if (values.representative) {
      await git("mv", "rename.txt", "renamed.txt");
      await git("rm", "remove.txt", "file-to-dir");
      await git("rm", "-r", "dir-to-file");
      await write("dir-to-file", "replacement");
      await write("file-to-dir/child", "child");
      await write(".artifacts/build-cache-inputs/added", "new input");
      await fs.chmod(path.join(root, "mode.sh"), 0o755);
      await fs.unlink(path.join(root, "link"));
      await fs.symlink("renamed.txt", path.join(root, "link"));
      await fs.mkdir(path.join(root, "submodule"));
      await git("update-index", "--add", "--cacheinfo", `160000,${beforeTree},submodule`);
      for (const directory of stagedInputs) {
        await write(`${directory}/node_modules/input`, "new input");
      }
    }
    await git("add", ".");
    await git("commit", "--quiet", "-am", "Synthetic refresh");
    const afterTree = await git("rev-parse", "HEAD");
    await fs.writeFile(
      path.join(fixture, "shape.json"),
      JSON.stringify({ files, bytes, beforeTree, afterTree, buildCacheInputs }),
    );
    console.log(JSON.stringify({ files, bytes: files * bytes, beforeTree, afterTree }));
  } else {
    assert(values["baseline-runtime"], "--baseline-runtime is required");
    const baselineUrl = pathToFileURL(path.resolve(values["baseline-runtime"])).href;
    const originalUrl = new URL(
      "../../src/gateway/worker-environments/workspace-manifest-computation.runtime.ts",
      import.meta.url,
    ).href;
    registerHooks({
      resolve(specifier, context, next) {
        return next(
          specifier,
          context.parentURL === baselineUrl ? { ...context, parentURL: originalUrl } : context,
        );
      },
    });
    const baselineRuntime = await import(baselineUrl);
    const shape = JSON.parse(await fs.readFile(path.join(fixture, "shape.json"), "utf8"));
    const baseRaw = await fs.readFile(path.join(fixture, "baseline.json"), "utf8");
    const baseRef = `sha256:${digest(baseRaw)}`;
    const actualGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const bin = path.join(fixture, "bin");
    await fs.mkdir(bin, { recursive: true });
    const nativeLog = path.join(fixture, "native.log");
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    assert(process.platform === "darwin", "Native CPU measurement currently uses macOS time -l");
    await fs.writeFile(
      path.join(bin, "git"),
      `#!/bin/sh\nexec /usr/bin/time -l -a -o ${quote(nativeLog)} ${quote(actualGit)} "$@"\n`,
      { mode: 0o755 },
    );
    process.env.PATH = bin + path.delimiter + process.env.PATH;
    const inventory = async (directory: string): Promise<{ files: number; bytes: number }> => {
      let files = 0,
        bytes = 0;
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          const child = await inventory(target);
          files += child.files;
          bytes += child.bytes;
        } else {
          files++;
          bytes += (await fs.lstat(target)).size;
        }
      }
      return { files, bytes };
    };
    let deleted = { files: 0, bytes: 0 };
    // A separate census run observes files before each owner cleanup, including
    // pack spools and fast-import input. Do not use its timings as performance proof.
    if (values.census) {
      const remove = fs.rm;
      fs.rm = async (target, options) => {
        if (typeof target === "string" && options?.recursive) {
          const counted = await inventory(target).catch(() => ({ files: 0, bytes: 0 }));
          deleted.files += counted.files;
          deleted.bytes += counted.bytes;
        }
        return remove(target, options);
      };
    }
    let expected:
      | { rawManifest: string; manifestRef: string; buildCacheInputs: string[]; commit: string }
      | undefined;
    for (let sample = values.census ? 0 : -1; sample < Number(values.samples); sample++) {
      for (const arm of values.mode === "candidate"
        ? ["B"]
        : sample % 2
          ? ["B", "A2", "A1"]
          : ["A1", "A2", "B"]) {
        deleted = { files: 0, bytes: 0 };
        const temporaryRoot = await fs.mkdtemp(path.join(fixture, "refresh-"));
        const nativeBefore = (await fs.readFile(nativeLog, "utf8").catch(() => "")).length;
        const cpu = process.cpuUsage();
        const allocated = getHeapStatistics().total_allocated_bytes;
        const started = performance.now();
        const common = {
          baseCommit: shape.afterTree,
          baseRaw: new TextEncoder().encode(baseRaw),
          baseRef,
          buildCacheInputs: shape.buildCacheInputs ?? [],
          action: "refresh_base" as const,
        };
        let result;
        if (arm !== "B") {
          for (const [name, commit] of [
            ["before", shape.beforeTree],
            ["after", shape.afterTree],
          ]) {
            await prepareLocalWorkspaceCheckout({
              source: root,
              destination: path.join(temporaryRoot, name),
              temporaryRoot,
              baseCommit: commit,
              branch: "refresh",
              signal: new AbortController().signal,
              assertCurrent: () => {},
            });
          }
          result = await baselineRuntime.executeWorkspaceManifestComputation({
            type: "workspace.manifest.base-refresh",
            input: {
              ...common,
              beforeRoot: path.join(temporaryRoot, "before"),
              afterRoot: path.join(temporaryRoot, "after"),
            },
          });
        } else {
          result = await executeWorkspaceManifestComputation({
            type: "workspace.manifest.base-refresh",
            input: {
              ...common,
              root,
              beforeTree: shape.beforeTree,
              afterTree: shape.afterTree,
              temporaryRoot,
            },
          });
        }
        const current = result.value;
        const commit = await workerWorkspaceResultStaging.stageWorkerWorkspaceResult({
          root,
          stagingRoot: path.join(temporaryRoot, "after"),
          stagedResultRef: `refs/openclaw/worker-results/io-proof-${shape.afterTree}`,
          baseManifestRef: baseRef,
          baseManifestRaw: baseRaw,
          currentManifestRef: current.manifestRef,
          currentManifestRaw: current.rawManifest,
          buildCacheInputs: current.buildCacheInputs,
        });
        const ownerMs = performance.now() - started;
        const usage = process.cpuUsage(cpu);
        const allocationBytes = getHeapStatistics().total_allocated_bytes - allocated;
        // Census is outside owner timing/CPU/allocation; deletion is measured separately.
        const retained = await inventory(temporaryRoot);
        const cleanupCpu = process.cpuUsage();
        const cleanupStarted = performance.now();
        await fs.rm(temporaryRoot, { recursive: true, force: true });
        const cleanupMs = performance.now() - cleanupStarted;
        const cleanupUsage = process.cpuUsage(cleanupCpu);
        const native = (await fs.readFile(nativeLog, "utf8")).slice(nativeBefore);
        const times = [...native.matchAll(/([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys/g)];
        const nativeCpuMs = times.reduce(
          (sum, match) => sum + (Number(match[2]) + Number(match[3])) * 1000,
          0,
        );
        const nativePeakRss = Math.max(
          0,
          ...[...native.matchAll(/(\d+)\s+maximum resident set size/g)].map((match) =>
            Number(match[1]),
          ),
        );
        const output = { ...current, commit };
        expected ??= output;
        assert.deepEqual(output, expected, `${arm} output bytes`);
        console.log(
          JSON.stringify({
            sample,
            arm,
            ownerMs,
            cleanupMs,
            wallMs: ownerMs + cleanupMs,
            cpuMs:
              (usage.user + usage.system + cleanupUsage.user + cleanupUsage.system) / 1000 +
              nativeCpuMs,
            nativeCpuMs,
            nativePeakRss,
            allocationBytes,
            rss: process.memoryUsage().rss,
            filesCreatedAndDeleted: retained.files,
            ...(values.census
              ? { deletedFiles: deleted.files, deletedFileBytes: deleted.bytes }
              : {}),
            temporaryBytes: retained.bytes,
            manifestRef: current.manifestRef,
            commit,
            load: os.loadavg(),
          }),
        );
      }
    }
  }
} finally {
  await drainGlobalSingletonLifecycleState();
}

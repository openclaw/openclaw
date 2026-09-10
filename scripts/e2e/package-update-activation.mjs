#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createReadStream, readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createGunzip } from "node:zlib";
import { createBoundedChildOutput } from "../../test/helpers/bounded-child-output.ts";
import {
  hasUnjoinedWork,
  inspectManagedProcessGroup,
  runManagedCommand,
  terminateManagedChild,
  waitForManagedProcessGroupExit,
} from "../lib/managed-child-process.mts";

// v2026.9.3 published-core verification binds these registry bytes to qualified
// code separately from the release workflow's provenance publisher commit.
const PUBLISHED_BASELINE = {
  version: "2026.9.3",
  codeSha: "1391f7cd2d40ab5bbcf2f5f831d3a64f520e72d7",
  publisherSha: "01403169248346f2a6d6dd02955fc956fa9e1fe9",
  sha256: "d1c63366833f8ae4a6ab4f3b60b1aa84ca82d03dba13d3d3eba989aa159e2449",
  integrity:
    "sha512-CzDHMeHdnjlIZ76ZyBb1lvLO4H/yBIMYXupFGGBN87x0853y3hg5nLAnKfxSKqLzqhbUKqy9ebDRAWWV4t8aew==",
};

async function main() {
  let unsettledCommand = false;
  async function exec(bin, args, options = {}) {
    let stdout = "",
      stderr = "";
    const abort = new AbortController();
    try {
      const code = await runManagedCommand({
        bin,
        args,
        cwd: options.cwd,
        env: options.env,
        timeoutMs: options.timeout ?? 180_000,
        timeoutKillGraceMs: 500,
        timeoutForceKillOnLeaderExit: true,
        requireProcessTreeExit: true,
        signal: abort.signal,
        stdio: ["ignore", "pipe", "pipe"],
        onReady(child) {
          const collect = (stream, bytes) => {
            if (stream === "stdout") {
              stdout += bytes.toString();
            } else {
              stderr += bytes.toString();
            }
            if (stdout.length + stderr.length > (options.maxBuffer ?? 4 * 1024 * 1024)) {
              abort.abort();
            }
          };
          child.stdout.on("data", (bytes) => collect("stdout", bytes));
          child.stderr.on("data", (bytes) => collect("stderr", bytes));
        },
      });
      if (code !== 0) {
        throw Object.assign(new Error(`${bin} exited ${code}`), { code, stdout, stderr });
      }
      return { stdout, stderr };
    } catch (error) {
      unsettledCommand ||= hasUnjoinedWork(error);
      throw error;
    }
  }
  const preload = fileURLToPath(
    new URL("../../test/fixtures/package-update-activation-preload.mjs", import.meta.url),
  );
  const { values } = parseArgs({
    options: {
      package: { type: "string" },
      candidate: { type: "string" },
      "source-sha": { type: "string" },
      "package-sha256": { type: "string" },
      "candidate-sha256": { type: "string" },
      "published-package": { type: "string" },
      cases: { type: "string", default: "smoke" },
    },
  });
  for (const name of ["package", "candidate", "source-sha", "package-sha256", "candidate-sha256"]) {
    assert.ok(values[name], `--${name} is required`);
  }
  assert.notEqual(process.platform, "win32", "ordinary POSIX npm only");
  assert.match(values["source-sha"], /^[a-f0-9]{40}$/);
  for (const name of ["package-sha256", "candidate-sha256"]) {
    assert.match(values[name], /^[a-f0-9]{64}$/);
  }
  const smokeCases = [
    "healthy",
    "absent-cli",
    "launcher-lost-ack",
    "authority-parent-replaced",
    "delegated-child",
    "interrupted-retirement",
  ];
  const finalDeletions = new Map(
    [
      ["helper", "recovery.mjs", "unlink"],
      ["journal", "operation.sqlite", "unlink"],
      ["anchor", "", "rmdir"],
    ].flatMap(([name, artifact, operation]) =>
      ["before", "after"].map((when) => [
        `${name}-${operation}-${when}`,
        {
          artifact,
          operation,
          when,
          state:
            name === "helper" && when === "before"
              ? "resumable"
              : name === "anchor" && when === "after"
                ? "removed"
                : "incomplete",
        },
      ]),
    ),
  );
  const allCases = [...smokeCases, "surviving-updater", ...finalDeletions.keys()];
  const cases =
    values.cases === "smoke"
      ? smokeCases
      : values.cases === "matrix"
        ? allCases
        : values.cases.split(",");
  assert.ok(cases.length && new Set(cases).size === cases.length);
  assert.ok(
    cases.every((name) => allCases.includes(name) || name === "published-upgrade"),
    "unknown activation scenario",
  );
  const usesPublished = cases.includes("published-upgrade");
  if (usesPublished) {
    assert.ok(values["published-package"], "--published-package is required");
  }
  const source = path.resolve(values.package);
  const candidate = path.resolve(values.candidate);
  const published = usesPublished ? path.resolve(values["published-package"]) : undefined;
  async function hash(file, algorithm = "sha256", encoding = "hex") {
    const digest = createHash(algorithm);
    for await (const chunk of createReadStream(file)) {
      digest.update(chunk);
    }
    return digest.digest(encoding);
  }
  assert.equal(await hash(source), values["package-sha256"]);
  assert.equal(await hash(candidate), values["candidate-sha256"]);
  if (published) {
    assert.equal(await hash(published), PUBLISHED_BASELINE.sha256, "published TGZ SHA-256");
    assert.equal(
      `sha512-${await hash(published, "sha512", "base64")}`,
      PUBLISHED_BASELINE.integrity,
      "published registry integrity",
    );
  }
  async function tarJson(file, member) {
    const { stdout } = await exec("tar", ["-xOf", file, `package/${member}`], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    return JSON.parse(stdout);
  }
  const before = await tarJson(source, "package.json");
  const after = await tarJson(candidate, "package.json");
  assert.equal(before.name, "openclaw");
  assert.equal(after.name, "openclaw");
  assert.notEqual(before.version, after.version, "use the recorded first-hop version fixture");
  for (const file of [source, candidate]) {
    assert.equal((await tarJson(file, "dist/build-info.json")).commit, values["source-sha"]);
  }
  if (published) {
    const manifest = await tarJson(published, "package.json");
    assert.equal(manifest.name, "openclaw");
    assert.equal(manifest.version, PUBLISHED_BASELINE.version);
    assert.equal(
      (await tarJson(published, "dist/build-info.json")).commit,
      PUBLISHED_BASELINE.codeSha,
    );
    assert.notEqual(manifest.version, after.version, "published incumbent must really upgrade");
  }
  const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const disk = await fs.statfs(temporaryRoot);
  const compressedBytes =
    (await fs.stat(source)).size +
    (await fs.stat(candidate)).size +
    (published ? (await fs.stat(published)).size : 0);
  async function unpackedTarBytes(file) {
    let bytes = 0;
    const input = createReadStream(file);
    const unpacked = input.pipe(createGunzip());
    input.once("error", (error) => unpacked.destroy(error));
    for await (const chunk of unpacked) {
      bytes += chunk.length;
    }
    return bytes;
  }
  const unpackedBytes =
    (await unpackedTarBytes(source)) +
    (await unpackedTarBytes(candidate)) +
    (published ? await unpackedTarBytes(published) : 0);
  // npm dependencies are not all in the core tarball. Reserve a conservative floor
  // and keep just one installed case at a time, reusing the task's npm cache.
  const requiredBytes = Math.max(4 * 1024 ** 3, unpackedBytes * 3);
  assert.ok(
    disk.bavail * disk.bsize > requiredBytes,
    "insufficient space for one isolated package case",
  );
  const runRoot = await fs.mkdtemp(path.join(temporaryRoot, "openclaw-activation-installed-"));
  emit({
    event: "inputs",
    sourceSha: values["source-sha"],
    packageSha256: values["package-sha256"],
    candidateSha256: values["candidate-sha256"],
    ...(published ? { published: PUBLISHED_BASELINE } : {}),
    harnessSha256: await hash(fileURLToPath(import.meta.url)),
    preloadSha256: await hash(preload),
    ownerSourceSha256: await Promise.all(
      [
        "../lib/managed-child-process.mts",
        "../lib/vitest-resource-ownership.mts",
        "../lib/windows-taskkill.mjs",
        "../windows-cmd-helpers.mjs",
        "../../test/helpers/bounded-child-output.ts",
      ].map(async (relative) => ({
        relative,
        sha256: await hash(fileURLToPath(new URL(relative, import.meta.url))),
      })),
    ),
    node: process.version,
    platform: process.platform,
    compressedBytes,
    unpackedBytes,
    reservedBytes: requiredBytes,
    cases,
    coordinatorIsolation: "test preload denies preferred root; existing TMPDIR fallback",
    childCoverage:
      "surviving-updater is the original owner; delegated-child uses the real post-core grant",
  });

  const prefixMarker = "OPENCLAW_ACTIVATION_TEST ";
  const ancestor = `
const { spawn } = require("node:child_process");
const [encoded, source] = process.argv.slice(1);
const config = JSON.parse(encoded);
const args = config.depth > 1 ? ["-e", source, JSON.stringify({...config, depth: config.depth - 1}), source] : config.args;
const child = spawn(process.execPath, args, { stdio: ["ignore", "inherit", "inherit"] });
const emit = value => process.stdout.write(${JSON.stringify(prefixMarker)} + JSON.stringify(value) + "\\n");
emit({event:"spawned", pid:child.pid, parentPid:process.pid});
child.once("error", error => {throw error});
child.once("exit", (code, signal) => emit({event:"reaped", pid:child.pid, code, signal}));
setInterval(() => {}, 1000);
`;
  function identity(pid) {
    if (process.platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat
        .slice(stat.lastIndexOf(")") + 1)
        .trimStart()
        .split(/\s+/u);
      assert.match(fields[19], /^\d+$/u, "cannot observe owned process start ticks");
      return String(Number(fields[19]));
    }
    const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 2_000,
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    });
    assert.equal(result.status, 0, `cannot observe owned process ${pid}`);
    assert.ok(result.stdout.trim());
    return String(Math.floor(Date.parse(`${result.stdout.trim()} UTC`) / 1000));
  }
  function alive(pid) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") {
        return false;
      }
      throw error;
    }
    if (process.platform === "linux") {
      try {
        // Match shared/pid-alive: a zombie leader alone cannot rule out live threads.
        const status = readFileSync(`/proc/${pid}/status`, "utf8");
        return !(/^State:\s+Z/mu.test(status) && /^Threads:[ \t]+1[ \t]*$/mu.test(status));
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }
    return true;
  }
  async function until(check, label, timeout = 120_000) {
    const deadline = Date.now() + timeout;
    while (!(await check())) {
      assert.ok(Date.now() < deadline, `timeout waiting for ${label}`);
      await delay(20);
    }
  }
  function envFor(root) {
    return {
      PATH: process.env.PATH,
      HOME: path.join(root, "home"),
      TMPDIR: path.join(root, "tmp"),
      LC_ALL: "C",
      TZ: "UTC",
      // HOME does not isolate the current user's loaded launchd/systemd services.
      OPENCLAW_PROFILE: path.basename(runRoot),
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_CONFIG_PATH: path.join(root, "state", "openclaw.json"),
      OPENCLAW_NO_RESPAWN: "1",
      npm_config_cache: path.join(runRoot, "npm-cache"),
      npm_config_update_notifier: "false",
    };
  }
  async function command(bin, args, root, timeout = 180_000) {
    return exec(bin, args, {
      cwd: root,
      env: {
        ...envFor(root),
        ...(bin === "npm"
          ? {
              NODE_OPTIONS: `--import ${JSON.stringify(preload)}`,
              OPENCLAW_ACTIVATION_TEST_ISOLATE_TMP: "1",
            }
          : {}),
      },
      encoding: "utf8",
      timeout,
      killSignal: "SIGKILL",
      maxBuffer: 4 * 1024 * 1024,
    });
  }
  function launch(root, args, { faults = [], ancestors = false, liveRoot } = {}) {
    const nodeArgs = ["--import", preload, ...args];
    const child = spawn(
      process.execPath,
      ancestors
        ? ["-e", ancestor, JSON.stringify({ args: nodeArgs, depth: 2 }), ancestor]
        : nodeArgs,
      {
        cwd: root,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...envFor(root),
          OPENCLAW_ACTIVATION_TEST_FAULTS: JSON.stringify(faults),
          OPENCLAW_ACTIVATION_TEST_ISOLATE_TMP: "1",
          OPENCLAW_ACTIVATION_TEST_OBSERVE_CHILDREN: "1",
          ...(liveRoot ? { OPENCLAW_ACTIVATION_TEST_LIVE_ROOT: liveRoot } : {}),
          NODE_OPTIONS: `--import ${JSON.stringify(preload)}`,
        },
      },
    );
    assert.ok(child.pid);
    const owned = new Map([[child.pid, identity(child.pid)]]);
    const groups = new Set([child.pid]);
    const events = [];
    const maxOutputBytes = 4 * 1024 * 1024;
    const outputBuffers = {
      stdout: createBoundedChildOutput(maxOutputBytes),
      stderr: createBoundedChildOutput(maxOutputBytes),
    };
    const { StringDecoder } = process.getBuiltinModule("node:string_decoder");
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    const buffered = { stdout: "", stderr: "" };
    let outputBytes = 0;
    let outputFailure;
    const failOutput = (error) => {
      outputFailure = Object.assign(error, {
        stdout: outputBuffers.stdout.text(),
        stderr: outputBuffers.stderr.text(),
      });
      // Discarded observation bytes cannot establish complete descendant custody.
      unsettledCommand = true;
      buffered.stdout = "";
      buffered.stderr = "";
      try {
        try {
          process.kill(child.pid, 0);
          assert.equal(identity(child.pid), owned.get(child.pid), "output-limit owner changed");
        } catch (cause) {
          if (cause.code !== "ESRCH") {
            throw cause;
          }
        }
        terminateManagedChild(child, "SIGKILL", {
          processGroupFallback: "never",
          onProcessGroupSignalError(cause) {
            throw cause;
          },
        });
      } catch (cause) {
        outputFailure = new AggregateError(
          [outputFailure, cause],
          "Output capture and owned root termination failed",
        );
      }
    };
    const consume = (stream, bytes) => {
      if (outputFailure) {
        return;
      }
      try {
        const remainingBytes = maxOutputBytes - outputBytes;
        outputBuffers[stream].append(bytes.subarray(0, remainingBytes));
        outputBytes += bytes.byteLength;
        if (outputBytes > maxOutputBytes) {
          failOutput(
            Object.assign(new Error("Combined child output exceeded 4 MiB"), {
              code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
            }),
          );
          return;
        }
        buffered[stream] += decoders[stream].write(bytes);
        let end;
        while ((end = buffered[stream].indexOf("\n")) >= 0) {
          const line = buffered[stream].slice(0, end);
          buffered[stream] = buffered[stream].slice(end + 1);
          if (!line.startsWith(prefixMarker)) {
            continue;
          }
          const event = JSON.parse(line.slice(prefixMarker.length));
          if (event.event === "observation-overflow") {
            unsettledCommand = true;
          }
          if (event.event === "spawned") {
            owned.set(
              event.pid,
              event.startIdentity === undefined ? identity(event.pid) : String(event.startIdentity),
            );
            if (event.detached) {
              groups.add(event.pid);
            }
          }
          events.push(event);
        }
      } catch (error) {
        failOutput(error);
      }
    };
    child.stdout.on("data", (bytes) => consume("stdout", bytes));
    child.stderr.on("data", (bytes) => consume("stderr", bytes));
    const exited = once(child, "exit");
    const closed = once(child, "close");
    const group = (pid) => ({ pid, exitCode: alive(pid) ? null : 1, signalCode: null });
    async function joinProcess() {
      try {
        await until(
          () =>
            [...groups].every(
              (pid) =>
                inspectManagedProcessGroup(group(pid), { errorPolicy: "indeterminate" }) === "dead",
            ) &&
            child.stdout.closed &&
            child.stderr.closed &&
            (child.exitCode !== null || child.signalCode !== null),
          "owned process, groups, and output closure",
          6_000,
        );
        await closed;
      } catch (error) {
        if (outputFailure) {
          throw new AggregateError(
            [outputFailure, error],
            "Output capture and process join failed",
            { cause: error },
          );
        }
        throw error;
      }
      if (outputFailure) {
        throw outputFailure;
      }
    }
    async function waitEvent(predicate, label) {
      await until(() => {
        if (outputFailure) {
          throw outputFailure;
        }
        if (events.some(predicate)) {
          return true;
        }
        assert.ok(
          child.exitCode === null && child.signalCode === null,
          `process exited before ${label}\n${outputBuffers.stdout.text()}\n${outputBuffers.stderr.text()}`,
        );
        assert.ok(
          !events.some(
            (entry) =>
              entry.event === "reaped" &&
              entry.code !== null &&
              !events.some(
                (spawned) =>
                  spawned.event === "spawned" &&
                  spawned.pid === entry.pid &&
                  spawned.fd3 !== undefined,
              ),
          ),
          `updater exited before ${label}\n${outputBuffers.stdout.text()}\n${outputBuffers.stderr.text()}`,
        );
        return false;
      }, label);
      if (outputFailure) {
        throw outputFailure;
      }
      return events.find(predicate);
    }
    async function kill(pid, reap = true) {
      assert.equal(identity(pid), owned.get(pid), "fixture process identity changed");
      process.kill(pid, "SIGKILL");
      if (pid === child.pid) {
        await until(
          () => child.signalCode !== null || child.exitCode !== null,
          "owned root exit",
          10_000,
        );
        assert.deepEqual(await exited, [null, "SIGKILL"]);
      } else if (reap) {
        const event = await waitEvent(
          (entry) => entry.event === "reaped" && entry.pid === pid,
          "reap",
        );
        assert.equal(event.signal, "SIGKILL");
      }
      await until(() => !alive(pid), `owned process ${pid} death`, 10_000);
    }
    async function killAll() {
      for (const pid of [...owned.keys()].toReversed()) {
        if (alive(pid)) {
          await kill(pid, child.signalCode === null);
        }
      }
      await joinProcess();
    }
    async function cleanup() {
      const errors = [];
      for (const pid of [...groups].toReversed()) {
        try {
          const state = inspectManagedProcessGroup(group(pid), { errorPolicy: "indeterminate" });
          if (state === "dead") {
            continue;
          }
          assert.equal(state, "live", "task-owned process group could not be inspected");
          if (alive(pid)) {
            assert.equal(identity(pid), owned.get(pid));
          }
          terminateManagedChild(
            { ...group(pid), kill: (signal) => process.kill(pid, signal) },
            "SIGKILL",
            { processGroupFallback: "never" },
          );
          await waitForManagedProcessGroupExit(group(pid), 5_000, { errorPolicy: "indeterminate" });
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        await joinProcess();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length) {
        throw new AggregateError(errors, "Task process cleanup remains unsettled");
      }
    }
    return {
      child,
      owned,
      closed,
      exited,
      kill,
      killAll,
      cleanup,
      joinProcess,
      observations: () => {
        if (outputFailure) {
          throw outputFailure;
        }
        return events.filter((event) => event.role);
      },
      checkpoint: (label) =>
        waitEvent((event) => event.event === "checkpoint" && event.label === label, label),
      output: () => {
        if (outputFailure) {
          throw outputFailure;
        }
        return { stdout: outputBuffers.stdout.text(), stderr: outputBuffers.stderr.text() };
      },
    };
  }
  async function exists(file) {
    try {
      await fs.lstat(file);
      return true;
    } catch (error) {
      if (error.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }
  async function runCase(name, index) {
    const publishedUpgrade = name === "published-upgrade";
    const root = path.join(runRoot, `${index}-${name}`);
    for (const part of ["home", "tmp", "state"]) {
      await fs.mkdir(path.join(root, part), { recursive: true });
    }
    const prefix = path.join(root, "prefix");
    const live = path.join(prefix, "lib", "node_modules", "openclaw");
    const bin = path.join(prefix, "bin", "openclaw");
    const processes = [];
    let failure;
    try {
      await command(
        "npm",
        [
          "install",
          "--global",
          "--prefix",
          prefix,
          publishedUpgrade ? published : source,
          "--no-fund",
          "--no-audit",
        ],
        root,
      );
      if (publishedUpgrade) {
        assert.equal(
          JSON.parse(await fs.readFile(path.join(live, "package.json"), "utf8")).version,
          PUBLISHED_BASELINE.version,
        );
        assert.equal(
          JSON.parse(await fs.readFile(path.join(live, "dist", "build-info.json"), "utf8")).commit,
          PUBLISHED_BASELINE.codeSha,
        );
        assert.match(
          (await command(process.execPath, [bin, "--version"], root)).stdout,
          /OpenClaw 2026\.9\.3 \(1391f7c\)/u,
        );
      }
      const footprint = await command("du", ["-sk", prefix], root);
      const installedBytes = Number(footprint.stdout.trim().split(/\s+/u)[0]) * 1024;
      assert.ok(Number.isSafeInteger(installedBytes) && installedBytes > 0);
      const space = await fs.statfs(root);
      assert.ok(
        space.bavail * space.bsize > installedBytes * 2,
        "insufficient space for candidate staging after measured incumbent installation",
      );
      emit({
        event: "footprint",
        name,
        installedBytes,
        availableBytes: space.bavail * space.bsize,
      });
      const sealedDigest = publishedUpgrade
        ? undefined
        : await hash(path.join(live, "dist", "package-update-activation-recovery.mjs"));
      const unknown = path.join(prefix, "bin", "unrelated-tool");
      await fs.writeFile(unknown, "unrelated executable\n", { mode: 0o755 });
      const anchorName = `.openclaw.package-activation-${createHash("sha256").update(live).digest("hex").slice(0, 24)}`;
      const anchor = path.join(path.dirname(live), anchorName);
      const recovery = path.join(anchor, "recovery.mjs");
      const finalDeletion = finalDeletions.get(name);
      const updateArgs = [
        path.join(live, "openclaw.mjs"),
        "update",
        "--yes",
        `--tag=${candidate}`,
        "--no-restart",
        "--json",
        "--timeout",
        "120",
      ];
      const faults =
        name === "healthy" || publishedUpgrade
          ? []
          : name === "delegated-child"
            ? [
                {
                  label: "publication",
                  operation: "rename",
                  path: path.join(root, "tmp"),
                  descendants: true,
                  basename: "plugins.json",
                  postCore: true,
                  argument: 1,
                  when: "before",
                },
              ]
            : [
                {
                  label: "publication",
                  operation: "rename",
                  path:
                    name === "launcher-lost-ack" || name === "interrupted-retirement" ? bin : live,
                  argument:
                    name === "launcher-lost-ack" || name === "interrupted-retirement" ? 1 : 0,
                  when: "after",
                },
              ];
      const updater = launch(root, updateArgs, {
        faults,
        ancestors: name !== "healthy" && !publishedUpgrade,
        liveRoot: publishedUpgrade ? live : undefined,
      });
      processes.push(updater);
      const runRecovery = async (action, succeeds = true) => {
        // No loader, repository dependency, authority environment, or canonical CLI.
        emit({ event: "helper", name, action, execution: "plain-node" });
        let result;
        try {
          result = { ...(await command(process.execPath, [recovery, action], root)), code: 0 };
        } catch (error) {
          result = { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: error.code };
        }
        assert.equal(result.code === 0, succeeds, `${action}: ${result.stdout}\n${result.stderr}`);
        return result;
      };
      const interruptRetirement = async (fault) => {
        emit({
          event: "helper",
          name,
          action: "retire",
          execution: "filesystem-checkpoint-preload",
          fault,
        });
        const retiring = launch(root, [recovery, "retire"], { faults: [fault] });
        processes.push(retiring);
        await retiring.checkpoint(fault.label);
        await retiring.killAll();
      };
      const assertPendingUpdate = async (inspection) => {
        const pending = launch(root, updateArgs);
        processes.push(pending);
        await until(
          () => pending.child.exitCode !== null || pending.child.signalCode !== null,
          "pending update refusal",
        );
        await pending.joinProcess();
        assert.notEqual(pending.child.exitCode, 0);
        assert.equal(pending.child.signalCode, null);
        const output = `${pending.output().stdout}\n${pending.output().stderr}`;
        assert.match(
          output,
          inspection ? /operator inspection/u : /recovery.*pending|publication is incomplete/u,
        );
        if (inspection) {
          assert.ok(!output.includes(recovery), "must not print a missing helper");
        }
      };
      if (name === "healthy" || publishedUpgrade) {
        await until(
          () => updater.child.exitCode !== null || updater.child.signalCode !== null,
          "healthy update",
        );
        assert.deepEqual(await updater.exited, [0, null], JSON.stringify(updater.output()));
        await updater.joinProcess();
        assert.equal(await exists(anchor), false);
        if (publishedUpgrade) {
          assert.equal(unsettledCommand, false, "published observation/custody limit exceeded");
          // Remove only our observer records; product stdout must still be valid JSON.
          const result = JSON.parse(
            updater
              .output()
              .stdout.split("\n")
              .filter((line) => !line.startsWith(prefixMarker))
              .join("\n"),
          );
          assert.equal(result.status, "ok");
          assert.equal(typeof result.postUpdate?.plugins?.changed, "boolean");
          const observed = updater.observations();
          const one = (event, role) => {
            const matches = observed.filter(
              (entry) => entry.event === event && entry.role === role,
            );
            assert.equal(matches.length, 1, `expected one ${role} ${event}`);
            return matches[0];
          };
          const original = one("started", "published-updater");
          assert.equal(original.pid, updater.child.pid);
          assert.equal(String(original.startIdentity), updater.owned.get(original.pid));
          assert.equal(original.packageVersion, PUBLISHED_BASELINE.version);
          assert.equal(original.codeSha, PUBLISHED_BASELINE.codeSha);
          const candidateChild = (role, parent, requireStarted) => {
            const spawned = one("spawned", role);
            assert.equal(spawned.parentPid, parent.pid, `${role} parent`);
            assert.equal(spawned.parentStartIdentity, parent.startIdentity, `${role} parent start`);
            assert.equal(String(spawned.startIdentity), updater.owned.get(spawned.pid));
            assert.equal(spawned.packageVersion, after.version);
            assert.equal(spawned.codeSha, values["source-sha"]);
            assert.equal(spawned.fd3, false, "published upgrade has no retained activation grant");
            if (requireStarted) {
              const started = one("started", role);
              for (const field of [
                "pid",
                "parentPid",
                "startIdentity",
                "packageVersion",
                "codeSha",
              ]) {
                assert.equal(started[field], spawned[field], `${role} started ${field}`);
              }
            }
            return spawned;
          };
          const doctor = candidateChild("active-doctor", original, false);
          const migrated = candidateChild("candidate-migrated-finalizer", original, true);
          assert.deepEqual(
            observed.filter((entry) => entry.role === "candidate-post-core"),
            [],
            "the fresh migrated candidate must converge plugins without a post-core grandchild",
          );
          const postPluginDoctorRequired = result.postUpdate.plugins.changed;
          const postPluginDoctor = postPluginDoctorRequired
            ? candidateChild("post-plugin-doctor", migrated, true)
            : null;
          if (!postPluginDoctorRequired) {
            assert.deepEqual(
              observed.filter((entry) => entry.role === "post-plugin-doctor"),
              [],
              "unchanged plugins do not require a post-plugin Doctor",
            );
          }
          emit({
            event: "handoff",
            name,
            kind: "published-updater-to-candidate-migrated-finalizer",
            original,
            doctor,
            migrated,
            postPluginDoctorRequired,
            postPluginDoctor,
          });
        }
      } else {
        const checkpoint = await updater.checkpoint("publication");
        assert.equal(
          await hash(recovery),
          sealedDigest,
          "recovery must copy the real sealed artifact",
        );
        assert.ok(
          `${updater.output().stdout}\n${updater.output().stderr}`.includes(recovery),
          "recovery command was not printed before mutation",
        );
        if (name === "surviving-updater" || name === "delegated-child") {
          for (const pid of [...updater.owned.keys()].toReversed()) {
            if (pid !== checkpoint.pid) {
              await updater.kill(pid);
            }
          }
          await runRecovery("repair", false);
          assert.equal(alive(checkpoint.pid), true);
          await updater.kill(checkpoint.pid, false);
          await updater.joinProcess();
        } else {
          await updater.killAll();
        }
        if (name === "absent-cli" || name === "authority-parent-replaced") {
          assert.equal(await exists(live), false);
          await assert.rejects(command(process.execPath, [bin, "--version"], root));
        }
        if (name === "authority-parent-replaced") {
          const coordinator = path.join(root, "tmp", `openclaw-${process.getuid()}`);
          const saved = `${coordinator}.original`;
          const database = path.join(coordinator, "managed-update-handoffs.sqlite");
          await fs.rename(coordinator, saved);
          await fs.mkdir(coordinator, { mode: 0o700 });
          await fs.copyFile(path.join(saved, "managed-update-handoffs.sqlite"), database);
          await fs.chmod(database, 0o600);
          const replacementDigest = await hash(database);
          await runRecovery("repair", false);
          assert.equal(await hash(database), replacementDigest);
          assert.equal(await exists(live), false);
          await fs.rm(coordinator, { recursive: true });
          await fs.rename(saved, coordinator);
        }
        await runRecovery("repair");
        const second = await runRecovery("repair");
        assert.match(second.stdout, /publication-complete/);
        if (name === "interrupted-retirement") {
          await interruptRetirement({
            label: "retirement",
            operation: "remove",
            path: path.join(anchor, "previous"),
            descendants: true,
            when: "after",
          });
          assert.equal(await exists(recovery), true);
          await interruptRetirement({
            label: "before-helper-unlink",
            operation: "unlink",
            path: recovery,
            when: "before",
          });
          await assertPendingUpdate(false);
        }
        if (finalDeletion) {
          await interruptRetirement({
            label: name,
            operation: finalDeletion.operation,
            path: path.join(anchor, finalDeletion.artifact),
            when: finalDeletion.when,
          });
          if (finalDeletion.state !== "removed") {
            await assertPendingUpdate(finalDeletion.state === "incomplete");
          }
          if (finalDeletion.state === "incomplete") {
            assert.equal(await exists(anchor), true);
            assert.equal(await exists(recovery), false);
            assert.deepEqual(
              await fs.readdir(anchor),
              finalDeletion.artifact === "recovery.mjs" ||
                (finalDeletion.artifact === "operation.sqlite" && finalDeletion.when === "before")
                ? ["operation.sqlite"]
                : [],
            );
          }
        }
        if (!finalDeletion || finalDeletion.state === "resumable") {
          await runRecovery("retire");
          assert.equal(await exists(anchor), false);
        } else if (finalDeletion.state === "removed") {
          // The helper is gone; acknowledge neither a successful reply nor retry idempotence.
          assert.equal(await exists(anchor), false);
        }
      }
      const selected = JSON.parse(await fs.readFile(path.join(live, "package.json"), "utf8"));
      assert.equal(selected.version, after.version);
      if (publishedUpgrade) {
        assert.equal(
          JSON.parse(await fs.readFile(path.join(live, "dist", "build-info.json"), "utf8")).commit,
          values["source-sha"],
        );
      }
      assert.match(
        (await command(process.execPath, [bin, "--version"], root)).stdout,
        new RegExp(after.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      );
      assert.equal(await fs.readFile(unknown, "utf8"), "unrelated executable\n");
      emit({ event: "case", name, status: "passed", version: selected.version });
    } catch (error) {
      failure = { error };
    }
    // Join every owner before deleting evidence; cleanup must not mask the case failure.
    const errors = [];
    for (const process of [...processes].toReversed()) {
      try {
        await process.cleanup();
        processes.splice(processes.indexOf(process), 1);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length || unsettledCommand) {
      emit({ event: "retained", name, path: root });
      throw new AggregateError(
        failure ? [failure.error, ...errors] : errors,
        "Task custody remains unsettled; evidence retained",
        failure ? { cause: failure.error } : undefined,
      );
    }
    if (failure) {
      emit({ event: "retained", name, path: root });
      throw failure.error;
    }
    await fs.rm(root, { recursive: true });
  }
  let complete = false;
  try {
    for (const [index, name] of cases.entries()) {
      await runCase(name, index);
    }
    complete = true;
    emit({ event: "complete", status: "passed", cases: cases.length });
  } finally {
    if (complete) {
      await fs.rm(runRoot, { recursive: true });
    } else {
      process.stderr.write(`Activation evidence retained at ${runRoot}\n`);
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
  console.error("[package-update-activation] FAILED (exit 1)");
}

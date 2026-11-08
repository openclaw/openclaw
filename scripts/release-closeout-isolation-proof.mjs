#!/usr/bin/env node
// Opt-in integration proof: REAL Docker, release helper and pinned ClawHub CLI.
// Use a disposable hosted Ubuntu runner, without release credentials. Prepare:
// pnpm install --frozen-lockfile --ignore-scripts
// bash scripts/materialize-clawhub-cli.sh .github/release/clawhub-cli .clawhub-cli
// docker pull <IMAGE below>
// node scripts/release-closeout-isolation-proof.mjs --tooling . --output <NEW-dir>
// --self-test is only a local machinery check, NOT Docker evidence.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IMAGE =
  "docker.io/library/node:24.22.1-bookworm@sha256:6449e19d8184d84062525b6a7524def03146c2cb04a7f08b076680d0e8e4240a";
const PACKAGE = "extensions/diagnostics-otel";
const MARKER = "ISOLATION_PROOF:";
const ENV_KEYS = [
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "NPM_TOKEN",
  "NODE_AUTH_TOKEN",
  "ACTIONS_RUNTIME_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ISOLATION_PROOF_RUNNER_SECRET",
  "GITHUB_ENV",
  "GITHUB_OUTPUT",
  "GITHUB_PATH",
  "GITHUB_STEP_SUMMARY",
  "DOCKER_CONFIG",
  "DOCKER_HOST",
];
const DENIED = new Set(["ENOENT", "EACCES", "EPERM", "EROFS", "ENOTDIR"]);
const READ_LABELS = ["runner-npmrc", "runner-git", "runner-docker", "tooling-npmrc", "tooling-git"];
const WRITE_LABELS = [
  "source-input",
  "tooling-script",
  "tooling-metadata",
  "github-env",
  "github-output",
  "github-path",
  "github-summary",
];
const SOCKET_LABELS = ["docker-socket", "run-docker-socket"];
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// Serialized into the malicious candidate; never invoked on the host.
async function attack(config) {
  const { readFileSync, writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
  const { connect } = await import("node:net");
  const denied = (operation) => {
    try {
      operation();
      return "ALLOWED";
    } catch (error) {
      return error.code ?? "UNKNOWN";
    }
  };
  const report = {
    schema: 1,
    nonce: config.nonce,
    mode: config.mode,
    envAbsent: config.envKeys.every((key) => process.env[key] === undefined),
    cleanHome: process.env.HOME === "/tmp/home",
    reads: Object.fromEntries(
      config.reads.map(([key, file]) => [key, denied(() => readFileSync(file))]),
    ),
    writes: Object.fromEntries(
      config.writes.map(([key, file]) => [
        key,
        denied(() => writeFileSync(file, "ATTACK-MUTATION\n")),
      ]),
    ),
    sockets: {},
  };
  for (const [key, file] of config.sockets) {
    report.sockets[key] = await new Promise((resolve) => {
      const socket = connect(file);
      socket.once("connect", () => {
        socket.destroy();
        resolve("ALLOWED");
      });
      socket.once("error", (error) => resolve(error.code ?? "UNKNOWN"));
      socket.setTimeout(1500, () => {
        socket.destroy();
        resolve("TIMEOUT");
      });
    });
  }
  // Positive controls: hook ran and its private source copy is writable.
  const dir = mkdtempSync("/tmp/isolation-proof-control-");
  writeFileSync(dir + "/control", "private-write-ok");
  writeFileSync("isolation-proof-private-copy.txt", "private-write-ok");
  report.positiveControls =
    readFileSync(dir + "/control", "utf8") === "private-write-ok" &&
    readFileSync("isolation-proof-private-copy.txt", "utf8") === "private-write-ok" &&
    JSON.parse(readFileSync("/source-input/package.json", "utf8")).name === "openclaw" &&
    JSON.parse(readFileSync("/tooling/extensions/diagnostics-otel/openclaw.plugin.json", "utf8"))
      .id === "diagnostics-otel";
  rmSync(dir, { recursive: true });
  console.log("::error::isolation-proof-synthetic-workflow-command");
  console.log("::set-env name=ISOLATION_PROOF_INJECTED::synthetic");
  console.log(config.marker + JSON.stringify(report));
  if (config.mode === "failure") {
    console.error("ISOLATION_PROOF_INTENTIONAL_ASSET_FAILURE");
    process.exitCode = 73;
  }
  if (config.mode === "cancellation") {
    setInterval(() => {}, 1000);
  }
}

function validateReport(report, nonce, mode) {
  assert.equal(report?.schema, 1);
  assert.equal(report.nonce, nonce);
  assert.equal(report.mode, mode);
  assert.equal(report.envAbsent, true, "runner environment reached asset hook");
  assert.equal(report.cleanHome, true);
  assert.equal(report.positiveControls, true, "asset hook positive controls did not run");
  for (const [group, labels] of [
    ["reads", READ_LABELS],
    ["writes", WRITE_LABELS],
    ["sockets", SOCKET_LABELS],
  ]) {
    assert.deepEqual(Object.keys(report[group]).toSorted(), labels.toSorted());
    for (const [label, result] of Object.entries(report[group])) {
      assert(
        DENIED.has(result),
        String(group) + "/" + label + ": expected explicit denial, got " + result,
      );
    }
  }
}

function extractReport(log, wrapped) {
  const lines = log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      if (!wrapped) {
        return line;
      }
      assert(line.startsWith("[isolated pack] "), "unquoted helper output: " + line.slice(0, 120));
      return JSON.parse(line.slice("[isolated pack] ".length));
    });
  const reports = lines.filter((line) => line.startsWith(MARKER));
  assert.equal(reports.length, 1, "exactly one real asset-hook report required");
  assert(lines.includes("::error::isolation-proof-synthetic-workflow-command"));
  assert(lines.includes("::set-env name=ISOLATION_PROOF_INJECTED::synthetic"));
  return JSON.parse(reports[0].slice(MARKER.length));
}

function workflowCleanup(tooling) {
  const workflow = fs.readFileSync(
    path.join(tooling, ".github/workflows/plugin-clawhub-release.yml"),
    "utf8",
  );
  const match = workflow.match(
    / {6}- name: Remove isolated pack container\n([\s\S]*?)(?=\n {6}- name:)/u,
  );
  assert(match, "real workflow cancellation cleanup step missing");
  assert(match[1].includes("if: always() && inputs.prepared_artifact == ''"));
  const run = match[1].split("        run: |\n")[1];
  assert(run, "workflow cleanup changed; review proof");
  return run
    .trimEnd()
    .split("\n")
    .map((line) => {
      assert(line.startsWith("          "), "unexpected cleanup indentation");
      return line.slice(10);
    })
    .join("\n");
}

function selfTest() {
  const valid = {
    schema: 1,
    nonce: "n",
    mode: "success",
    envAbsent: true,
    cleanHome: true,
    positiveControls: true,
    reads: Object.fromEntries(READ_LABELS.map((label) => [label, "ENOENT"])),
    writes: Object.fromEntries(WRITE_LABELS.map((label) => [label, "EROFS"])),
    sockets: Object.fromEntries(SOCKET_LABELS.map((label) => [label, "ENOENT"])),
  };
  validateReport(valid, "n", "success");
  for (const mutate of [
    (r) => {
      r.envAbsent = false;
    },
    (r) => {
      r.positiveControls = false;
    },
    (r) => {
      r.writes[WRITE_LABELS[0]] = "ALLOWED";
    },
    (r) => {
      delete r.reads[READ_LABELS[0]];
    },
    (r) => {
      r.sockets[SOCKET_LABELS[0]] = "TIMEOUT";
    },
    (r) => {
      r.nonce = "wrong-run";
    },
  ]) {
    const bad = structuredClone(valid);
    mutate(bad);
    assert.throws(() => validateReport(bad, "n", "success"));
  }
  const wrapped = [
    "::error::isolation-proof-synthetic-workflow-command",
    "::set-env name=ISOLATION_PROOF_INJECTED::synthetic",
    MARKER + JSON.stringify(valid),
  ]
    .map((line) => "[isolated pack] " + JSON.stringify(line))
    .join("\n");
  assert.deepEqual(extractReport(wrapped, true), valid);
  assert.throws(() => extractReport(wrapped + "\n::error::unquoted", true));
  assert.throws(() => extractReport(wrapped + "\n" + wrapped, true));
  const syntax = spawnSync(process.execPath, ["--check", "--input-type=module"], {
    input: "(" + attack.toString() + ");",
    encoding: "utf8",
  });
  assert.equal(syntax.status, 0, syntax.stderr);
  workflowCleanup(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  console.log(
    "PASS: proof validator, negative controls, log quoting, candidate syntax, real workflow cleanup extraction (no Docker run)",
  );
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const args =
    rawArgs.length === 0
      ? [
          "--tooling",
          repoRoot,
          "--output",
          path.join(repoRoot, ".artifacts/closeout-isolation-proof"),
        ]
      : rawArgs;
  if (args.length === 1 && args[0] === "--self-test") {
    selfTest();
    return;
  }
  assert(
    args.length === 4 && args[0] === "--tooling" && args[2] === "--output",
    "usage: --tooling <prepared-checkout> --output <NEW-directory> | --self-test",
  );
  assert.equal(process.platform, "linux", "real proof requires hosted Linux Docker");
  const original = fs.realpathSync(args[1]);
  const output = path.resolve(args[3]);
  assert(!fs.existsSync(output), "output must not exist (never reuse a proof run)");
  assert(!output.includes(",") && !output.includes("\n"));
  const helper = path.join(original, "scripts/plugin-clawhub-pack-isolated.mjs");
  const cleanup = workflowCleanup(original);
  const cli = path.join(original, ".clawhub-cli/node_modules/.bin/clawhub");
  fs.accessSync(cli, fs.constants.X_OK);
  assert.equal(
    JSON.parse(
      fs.readFileSync(
        path.join(original, ".clawhub-cli/node_modules/clawhub/package.json"),
        "utf8",
      ),
    ).version,
    "0.23.3",
  );
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
    fs.statSync(path.join(original, entry));
  }
  fs.mkdirSync(output, { recursive: true });
  // Keep dependency symlinks and candidate staging OUT of the upload directory.
  const work = fs.mkdtempSync(path.join(path.dirname(output), ".closeout-isolation-work-"));
  const runner = path.join(work, "synthetic-runner");
  fs.mkdirSync(runner);
  const dockerConfig = path.join(runner, ".docker");
  fs.mkdirSync(dockerConfig);
  // Driver/Docker never inherit real credentials, contexts or command files.
  const baseEnv = { PATH: process.env.PATH, HOME: runner, TMPDIR: runner };
  const command = (bin, argv, options = {}) => {
    const result = spawnSync(bin, argv, {
      env: baseEnv,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 32 * 1024 * 1024,
      ...options,
    });
    if (result.error) {
      throw result.error;
    }
    return result;
  };
  const docker = (argv) => command("docker", ["--config", dockerConfig, ...argv]);
  const must = (result, label) => {
    assert.equal(result.status, 0, label + ": " + (result.stderr || result.stdout));
    return result.stdout;
  };
  must(docker(["info", "--format", "{{.ServerVersion}}"]), "real Docker daemon unavailable");
  const imageId = must(
    docker(["image", "inspect", IMAGE, "--format", "{{.Id}}"]),
    "pull pinned image first",
  ).trim();
  const nonce = randomUUID();
  const synthetic = "synthetic-isolation-proof-" + nonce;
  const credentialFiles = [
    path.join(runner, ".npmrc"),
    path.join(runner, "git-config"),
    path.join(dockerConfig, "config.json"),
  ];
  for (const file of credentialFiles) {
    fs.writeFileSync(file, synthetic + "\n");
  }
  json(credentialFiles[2], {
    auths: { "example.invalid": { auth: Buffer.from(synthetic).toString("base64") } },
  });
  const commandFiles = Object.fromEntries(
    ["ENV", "OUTPUT", "PATH", "STEP_SUMMARY"].map((key) => [
      "GITHUB_" + key,
      path.join(runner, "command-" + key),
    ]),
  );
  for (const file of Object.values(commandFiles)) {
    fs.writeFileSync(file, "synthetic-command-file-baseline\n");
  }
  const tooling = path.join(work, "trusted-tooling");
  fs.mkdirSync(tooling);
  // Executable tooling copied byte-for-byte, never stubbed. Dependency/source
  // trees stay the prepared checkout's read-only bind inputs. All attacked
  // mutation targets below belong to this disposable proof, not the checkout.
  fs.cpSync(path.join(original, "scripts"), path.join(tooling, "scripts"), { recursive: true });
  for (const entry of ["src", "packages", "patches", "node_modules", ".clawhub-cli"]) {
    fs.symlinkSync(fs.realpathSync(path.join(original, entry)), path.join(tooling, entry));
  }
  for (const entry of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json"]) {
    fs.copyFileSync(path.join(original, entry), path.join(tooling, entry));
  }
  fs.mkdirSync(path.join(tooling, PACKAGE), { recursive: true });
  for (const entry of ["package.json", "openclaw.plugin.json"]) {
    fs.copyFileSync(path.join(original, PACKAGE, entry), path.join(tooling, PACKAGE, entry));
  }
  fs.mkdirSync(path.join(tooling, ".git"));
  fs.writeFileSync(path.join(tooling, ".git/config"), synthetic);
  fs.writeFileSync(path.join(tooling, ".npmrc"), synthetic);
  fs.writeFileSync(
    path.join(tooling, "scripts/isolation-proof-canary.txt"),
    "trusted-input-baseline\n",
  );
  assert.equal(hash(helper), hash(path.join(tooling, "scripts/plugin-clawhub-pack-isolated.mjs")));
  const protectedFiles = [
    ...credentialFiles,
    ...Object.values(commandFiles),
    path.join(tooling, ".npmrc"),
    path.join(tooling, ".git/config"),
    path.join(tooling, "scripts/isolation-proof-canary.txt"),
    ...["plugin-clawhub-pack-isolated.mjs", "plugin-clawhub-publish.sh"].map((file) =>
      path.join(tooling, "scripts", file),
    ),
    path.join(tooling, PACKAGE, "openclaw.plugin.json"),
  ];
  const baseline = new Map(protectedFiles.map((file) => [file, hash(file)]));
  const unchanged = () => {
    for (const [file, before] of baseline) {
      assert.equal(hash(file), before, "host mutation: " + file);
    }
  };
  const prefix = "clawhub-pack-" + Date.now() + "-" + process.pid;
  const names = [0, 1, 2].map((i) => prefix + "-" + i);
  json(path.join(output, "containers.json"), names);
  fs.writeFileSync(path.join(output, "workflow-cleanup.sh"), cleanup + "\n");
  const cleanContainer = (name) =>
    must(
      command("bash", [path.join(output, "workflow-cleanup.sh")], {
        env: { ...baseEnv, PACK_CONTAINER_NAME: name },
      }),
      "real workflow outer cleanup",
    );
  const assertAbsent = (name) => {
    const result = docker(["container", "inspect", name]);
    assert.notEqual(result.status, 0, "container survived cleanup");
    assert.match(
      result.stderr,
      /No such (?:object|container)/u,
      "absence must not be inferred from daemon error",
    );
  };
  const results = [];
  let child;
  let proofError;
  try {
    for (const [index, mode] of ["success", "failure", "cancellation"].entries()) {
      const name = names[index];
      const source = path.join(work, "candidate-" + mode);
      fs.mkdirSync(path.join(source, PACKAGE), { recursive: true });
      for (const entry of ["package.json", "tsconfig.json"]) {
        fs.copyFileSync(path.join(original, entry), path.join(source, entry));
      }
      // Repository metadata + dependency-free TS runtime fixture. The invalid
      // candidate category must be replaced by the trusted metadata overlay.
      const manifest = JSON.parse(
        fs.readFileSync(path.join(tooling, PACKAGE, "openclaw.plugin.json"), "utf8"),
      );
      manifest.categories = ["intentionally-invalid-candidate-category"];
      json(path.join(source, PACKAGE, "openclaw.plugin.json"), manifest);
      const pkg = JSON.parse(fs.readFileSync(path.join(tooling, PACKAGE, "package.json"), "utf8"));
      delete pkg.dependencies;
      delete pkg.devDependencies;
      delete pkg.optionalDependencies;
      pkg.openclaw.assetScripts = { build: "node isolation-proof-asset.mjs" };
      json(path.join(source, PACKAGE, "package.json"), pkg);
      fs.writeFileSync(
        path.join(source, PACKAGE, "index.ts"),
        "export default { id: 'diagnostics-otel', name: 'Isolation proof fixture', register() {} };\n",
      );
      const config = {
        nonce,
        mode,
        marker: MARKER,
        envKeys: ENV_KEYS,
        reads: [
          ["runner-npmrc", credentialFiles[0]],
          ["runner-git", credentialFiles[1]],
          ["runner-docker", credentialFiles[2]],
          ["tooling-npmrc", "/tooling/.npmrc"],
          ["tooling-git", "/tooling/.git/config"],
        ],
        writes: [
          ["source-input", "/source-input/package.json"],
          ["tooling-script", "/tooling/scripts/isolation-proof-canary.txt"],
          ["tooling-metadata", "/tooling/extensions/diagnostics-otel/openclaw.plugin.json"],
          ...Object.entries(commandFiles).map(([key, file]) => [
            {
              GITHUB_ENV: "github-env",
              GITHUB_OUTPUT: "github-output",
              GITHUB_PATH: "github-path",
              GITHUB_STEP_SUMMARY: "github-summary",
            }[key],
            file,
          ]),
        ],
        sockets: [
          ["docker-socket", "/var/run/docker.sock"],
          ["run-docker-socket", "/run/docker.sock"],
        ],
      };
      fs.writeFileSync(
        path.join(source, PACKAGE, "isolation-proof-asset.mjs"),
        "await (" + attack.toString() + ")(" + JSON.stringify(config) + ");\n",
      );
      const sourceHashes = new Map(
        [
          "package.json",
          PACKAGE + "/package.json",
          PACKAGE + "/openclaw.plugin.json",
          PACKAGE + "/index.ts",
        ].map((file) => [path.join(source, file), hash(path.join(source, file))]),
      );
      const packOutput = path.join(work, "pack-" + mode);
      const env = {
        ...baseEnv,
        ...Object.fromEntries(ENV_KEYS.map((key) => [key, synthetic])),
        ...commandFiles,
        DOCKER_CONFIG: dockerConfig,
        DOCKER_HOST: "unix:///synthetic-invalid-docker.sock",
        SOURCE_REPO: "openclaw/openclaw",
        SOURCE_COMMIT: "1".repeat(40),
        SOURCE_REF: "refs/tags/v2026.11.2",
        PACKAGE_TAG: "latest",
        PACK_CONTAINER_NAME: name,
      };
      const logFile = path.join(output, mode + ".log");
      const logFd = fs.openSync(logFile, "wx");
      child = spawn(process.execPath, [helper, source, tooling, packOutput, PACKAGE], {
        env,
        detached: true,
        stdio: ["ignore", logFd, logFd],
      });
      fs.closeSync(logFd);
      const done = new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      });
      let report;
      let exit;
      if (mode === "cancellation") {
        const deadline = Date.now() + 180_000;
        let raw = "";
        while (Date.now() < deadline) {
          const logs = docker(["logs", name]);
          raw = (logs.stdout ?? "") + (logs.stderr ?? "");
          if (raw.includes(MARKER)) {
            break;
          }
          assert(
            child.exitCode === null && child.signalCode === null,
            "helper exited before cancellation hook",
          );
          await sleep(500);
        }
        report = extractReport(raw, false);
        validateReport(report, nonce, mode);
        const inspection = JSON.parse(
          must(docker(["container", "inspect", name]), "inspect real container"),
        )[0];
        assert.equal(inspection.Image, imageId);
        assert.equal(inspection.State.Running, true);
        assert.equal(inspection.HostConfig.ReadonlyRootfs, true);
        assert.equal(inspection.HostConfig.Privileged, false);
        assert.equal(inspection.HostConfig.NetworkMode, "bridge");
        assert(inspection.HostConfig.CapDrop.includes("ALL"));
        assert(inspection.HostConfig.SecurityOpt.includes("no-new-privileges"));
        assert.equal(inspection.Config.User, process.getuid() + ":" + process.getgid());
        assert(!inspection.Mounts.some((mount) => mount.Destination.includes("docker.sock")));
        for (const mount of inspection.Mounts.filter((m) => m.Type === "bind")) {
          assert.equal(mount.RW, mount.Destination === "/output");
        }
        assert(
          !inspection.Config.Env.some((entry) =>
            ENV_KEYS.some((key) => entry.startsWith(key + "=")),
          ),
        );
        // Real helper is synchronous: cancellation needs the workflow's outer
        // cleanup. Prove the container survives client termination, then remove.
        // SIGKILL models the runner hard-stop without Docker signal proxying
        // terminating the container on our behalf.
        process.kill(-child.pid, "SIGKILL");
        exit = await done;
        assert.notEqual(exit.code, 0);
        assert.equal(
          JSON.parse(must(docker(["inspect", name]), "container must remain for outer cleanup"))[0]
            .State.Running,
          true,
        );
        cleanContainer(name);
        fs.writeFileSync(path.join(output, "cancellation-container.log"), raw);
        json(path.join(output, "cancellation-inspect.json"), inspection);
      } else {
        const timeout = setTimeout(() => {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }, 17 * 60_000);
        try {
          exit = await done;
        } finally {
          clearTimeout(timeout);
        }
        const log = fs.readFileSync(logFile, "utf8");
        report = extractReport(log, true);
        validateReport(report, nonce, mode);
        if (mode === "success") {
          assert.equal(exit.code, 0, "real pack failed: see " + logFile);
        } else {
          assert.notEqual(exit.code, 0);
          assert(log.includes("ISOLATION_PROOF_INTENTIONAL_ASSET_FAILURE"));
        }
      }
      child = undefined;
      assertAbsent(name);
      unchanged();
      for (const [file, before] of sourceHashes) {
        assert.equal(hash(file), before, "read-only candidate changed");
      }
      const artifacts = fs.readdirSync(packOutput);
      let artifact;
      if (mode === "success") {
        assert.equal(artifacts.length, 1);
        assert(artifacts[0].endsWith(".tgz"));
        const file = path.join(packOutput, artifacts[0]);
        assert(fs.lstatSync(file).isFile());
        artifact = { sha256: hash(file), bytes: fs.statSync(file).size };
        const verification = command(
          "bash",
          [path.join(tooling, "scripts/plugin-clawhub-publish.sh"), "--validate-packed", file],
          {
            cwd: source,
            env: {
              ...baseEnv,
              SOURCE_REPO: env.SOURCE_REPO,
              SOURCE_COMMIT: env.SOURCE_COMMIT,
              SOURCE_REF: env.SOURCE_REF,
              PACKAGE_TAG: "latest",
              PACKAGE_DIR: PACKAGE,
              EXPECTED_CLAWHUB_PACKAGE_NAME: pkg.name,
              EXPECTED_CLAWHUB_PACKAGE_VERSION: pkg.version,
              EXPECTED_CLAWHUB_ARTIFACT_SHA256: artifact.sha256,
              EXPECTED_CLAWHUB_ARTIFACT_SIZE: String(artifact.bytes),
              OPENCLAW_CLAWHUB_CLI: cli,
            },
          },
        );
        fs.writeFileSync(
          path.join(output, "validate-packed.log"),
          verification.stdout + verification.stderr,
        );
        must(verification, "real artifact verifier + real CLI dry-run acceptance");
        const { inspectPackageTarballBytes, CLAWHUB_PUBLICATION_TAR_LIMITS } = await import(
          path.join(original, "scripts/plugin-publication-artifact.mjs")
        );
        const archive = inspectPackageTarballBytes(
          fs.readFileSync(file),
          CLAWHUB_PUBLICATION_TAR_LIMITS,
        );
        const trustedManifest = JSON.parse(
          fs.readFileSync(path.join(tooling, PACKAGE, "openclaw.plugin.json"), "utf8"),
        );
        assert.deepEqual(
          archive.pluginManifest.categories,
          trustedManifest.categories,
          "trusted metadata overlay not in actual tarball",
        );
        assert(
          archive.inventory.some(
            (entry) =>
              entry.path === "package/dist/index.js" || entry.path === "package/dist/index.mjs",
          ),
          "compiled runtime missing from actual tarball",
        );
        fs.copyFileSync(file, path.join(output, "accepted-clawpack.tgz"));
      } else {
        assert.deepEqual(artifacts, [], "failed/cancelled pack exported an artifact");
      }
      results.push({
        mode,
        container: name,
        exit,
        report,
        artifact,
        containerRemoved: true,
        protectedInputsUnchanged: true,
      });
      json(path.join(output, "progress.json"), results);
    }
  } catch (error) {
    proofError = error;
  }
  // Always try every cleanup, retaining the original failure as well.
  const cleanupErrors = [];
  if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") {
        cleanupErrors.push(error);
      }
    }
  }
  for (const name of names) {
    try {
      cleanContainer(name);
      assertAbsent(name);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    unchanged();
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length) {
    throw new AggregateError(
      [proofError, ...cleanupErrors].filter(Boolean),
      "Proof or cleanup failed",
    );
  }
  fs.rmSync(work, { recursive: true, force: true });
  if (proofError) {
    throw proofError instanceof Error
      ? proofError
      : new Error("Real isolation proof failed", { cause: proofError });
  }
  json(path.join(output, "result.json"), {
    schema: 1,
    status: "passed",
    image: IMAGE,
    imageId,
    helperSha256: hash(helper),
    cleanupSha256: createHash("sha256").update(cleanup).digest("hex"),
    cliVersion: "0.23.3",
    results,
  });
  console.log(
    "PASS: real Docker isolation, pack acceptance, failure cleanup, cancellation + real workflow cleanup. Evidence: " +
      output +
      "/result.json",
  );
}

main().catch(
  /** @param {unknown} error */ (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);

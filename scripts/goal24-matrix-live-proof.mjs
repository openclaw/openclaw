// Executes only on an ephemeral GitHub-hosted VM; never on an operator host.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const candidate = "bf8ee2c6152a18386a175ad329013bc20a4a8051";
// Official v1.165.0 linux/amd64 manifest, resolved before admission.
export const image =
  "ghcr.io/element-hq/synapse@sha256:b7f105b3c5f6d8bdb0a1aaff51ec4264dd109d8ed5532009d176bcb28a57ca0a";
export const requiredCases = [
  "authenticated SDK send reaches the recipient",
  "accepted then 429 recovers one durable recipient event",
  "encrypted SDK send is decrypted by an independent recipient",
];
export function admitLive(report) {
  const cases = report.testResults.flatMap((suite) => suite.assertionResults);
  assert.equal(cases.length, requiredCases.length, "partial or extra live cases");
  assert.deepEqual(cases.map((test) => test.title).toSorted(), requiredCases.toSorted());
  assert.ok(
    cases.every((test) => test.status === "passed"),
    "failed live case",
  );
  return cases.map(({ title, status, duration }) => ({ title, status, duration }));
}

async function main() {
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
  assert.equal(process.platform, "linux");
  assert.equal(process.version, "v24.22.1");
  const root = process.cwd();
  const source = path.join(root, "source");
  const output = path.join(root, "proof-output");
  fs.mkdirSync(output, { recursive: true });
  const isolated = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, "goal24-matrix-live-"));
  for (const name of ["home", "tmp", "state", "cache", "synapse"]) {
    fs.mkdirSync(path.join(isolated, name));
  }
  const env = Object.fromEntries(
    ["PATH", "PNPM_HOME", "COREPACK_HOME"].flatMap((key) =>
      process.env[key] ? [[key, process.env[key]]] : [],
    ),
  );
  Object.assign(env, {
    HOME: path.join(isolated, "home"),
    TMPDIR: path.join(isolated, "tmp"),
    OPENCLAW_STATE_DIR: path.join(isolated, "state"),
    OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(isolated, "cache"),
    CI: "true",
    GITHUB_ACTIONS: "true",
    RUNNER_OS: "Linux",
    RUNNER_TEMP: isolated,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    OPENCLAW_NODE_TEST_PLAN_CONCURRENCY: "1",
    GOAL24_LIVE_OUTPUT: path.join(output, "observations.json"),
  });
  const summary = {
    candidate,
    tooling: process.env.GITHUB_SHA,
    image,
    node: process.version,
    outcome: "setup-failure",
    stages: [],
  };
  const save = () =>
    fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  const run = (name, cmd, args, seconds = 60, cwd = source) => {
    const fd = fs.openSync(path.join(output, name + ".log"), "w", 0o600);
    const start = Date.now();
    const result = spawnSync(
      "timeout",
      ["--signal=TERM", "--kill-after=15s", seconds + "s", cmd, ...args],
      { cwd, env, stdio: ["ignore", fd, fd], timeout: (seconds + 30) * 1000 },
    );
    fs.closeSync(fd);
    summary.stages.push({
      name,
      exitCode: result.status,
      signal: result.signal,
      durationMs: Date.now() - start,
    });
    save();
    assert.equal(result.status, 0, name + " failed; inspect its bounded log");
  };
  const capture = (cmd, args, cwd = source) => {
    const result = spawnSync(cmd, args, { cwd, env, encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 0, "capture failed: " + cmd);
    return result.stdout.trim();
  };
  const container = "goal24-matrix-live";
  let started = false;
  try {
    assert.equal(capture("git", ["rev-parse", "HEAD"]), candidate);
    assert.equal(capture("git", ["status", "--porcelain"]), "");
    assert.equal(
      spawnSync("git", ["config", "--local", "--get-regexp", "http.*extraheader"], {
        cwd: source,
        env,
      }).status,
      1,
    );
    run("install", "pnpm", ["install", "--frozen-lockfile"], 900);
    run("synapse-pull", "docker", ["pull", image], 240);
    summary.imageDigest = capture("docker", [
      "image",
      "inspect",
      image,
      "--format",
      "{{index .RepoDigests 0}}",
    ]);
    const data = path.join(isolated, "synapse");
    const uid = capture("id", ["-u"]),
      gid = capture("id", ["-g"]);
    const mount = ["-v", data + ":/data", "-e", "UID=" + uid, "-e", "GID=" + gid];
    run(
      "synapse-generate",
      "docker",
      [
        "run",
        "--rm",
        ...mount,
        "-e",
        "SYNAPSE_SERVER_NAME=matrix-proof.invalid",
        "-e",
        "SYNAPSE_REPORT_STATS=no",
        image,
        "generate",
      ],
      90,
    );
    fs.appendFileSync(
      path.join(data, "homeserver.yaml"),
      `
enable_registration: true
enable_registration_without_verification: true
` +
        `rc_registration:
  per_second: 100
  burst_count: 100
` +
        `rc_message:
  per_second: 100
  burst_count: 100
` +
        `federation_domain_whitelist: []
`,
    );
    run(
      "synapse-start",
      "docker",
      [
        "run",
        "-d",
        "--name",
        container,
        "--memory=2g",
        "--cpus=2",
        "--pids-limit=256",
        "-p",
        "127.0.0.1::8008",
        ...mount,
        image,
      ],
      60,
    );
    started = true;
    const address = capture("docker", ["port", container, "8008/tcp"]);
    assert.match(address, /^127\.0\.0\.1:\d+$/);
    env.GOAL24_HOMESERVER = "http://" + address;
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        ready = (
          await fetch(env.GOAL24_HOMESERVER + "/_matrix/client/versions", {
            signal: AbortSignal.timeout(1000),
          })
        ).ok;
      } catch {}
      if (ready) {
        break;
      }
      await delay(1000);
    }
    assert.ok(ready, "real Synapse did not become ready");
    summary.serverVersion = await (
      await fetch(env.GOAL24_HOMESERVER + "/_synapse/admin/v1/server_version")
    ).json();
    const fixture = path.join(root, "tooling/scripts/goal24-matrix-live.test.ts");
    const testFile = "extensions/matrix/src/matrix/goal24-live.test.ts";
    const bytes = fs.readFileSync(fixture);
    summary.fixtureHash = createHash("sha256").update(bytes).digest("hex");
    fs.writeFileSync(path.join(source, testFile), bytes);
    summary.outcome = "test-failure";
    run(
      "live",
      "node",
      [
        "scripts/run-vitest.mjs",
        testFile,
        "--maxWorkers=1",
        "--reporter=json",
        "--outputFile=" + path.join(output, "live.json"),
      ],
      600,
    );
    summary.cases = admitLive(JSON.parse(fs.readFileSync(path.join(output, "live.json"), "utf8")));
    summary.observations = JSON.parse(fs.readFileSync(env.GOAL24_LIVE_OUTPUT, "utf8"));
    summary.outcome = "pass";
  } finally {
    if (started) {
      // No server/config/state logs are uploaded: they may contain synthetic credentials.
      run("synapse-cleanup", "docker", ["rm", "-f", container], 60);
    }
    save();
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)
) {
  await main();
}

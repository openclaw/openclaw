// Disposable macOS hosted VM only. Executes an installed package, not source imports.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.equal(process.platform, "darwin");
const sourceSha = "d51696b32be02844d1801dd31819912401859b88";
const priorProofSha = "a9a084486e3df10193dfa9ac5ab9faa9f53a4619";
const root = process.cwd();
const source = path.join(root, "source");
const tooling = path.join(root, "tooling");
const output = path.join(root, "proof-output");
const isolated = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP, "goal24-audio-package-"));
for (const name of ["home", "tmp", "state", "cache", "install", "packed"]) {
  fs.mkdirSync(path.join(isolated, name));
}
fs.mkdirSync(output, { recursive: true });
const env = Object.fromEntries(
  ["PATH", "PNPM_HOME", "COREPACK_HOME", "DEVELOPER_DIR", "SDKROOT"].flatMap((key) =>
    process.env[key] ? [[key, process.env[key]]] : [],
  ),
);
Object.assign(env, {
  HOME: path.join(isolated, "home"),
  TMPDIR: path.join(isolated, "tmp"),
  TMP: path.join(isolated, "tmp"),
  TEMP: path.join(isolated, "tmp"),
  OPENCLAW_STATE_DIR: path.join(isolated, "state"),
  OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(isolated, "cache"),
  CI: "true",
  GITHUB_ACTIONS: "true",
  LANG: "en_US.UTF-8",
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  NODE_OPTIONS: "--max-old-space-size=8192",
});
const summary = {
  sourceSha,
  priorProofSha,
  toolingSha: process.env.GITHUB_SHA,
  stages: [],
  outcome: "setup-failure",
  claims: {
    installedPackage: false,
    missingFfmpegFallback: false,
    recordingAdapterDispatch: false,
    messagesTransport: false,
    receivingDevicePlayback: false,
  },
};
const save = () =>
  fs.writeFileSync(path.join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
function command(name, binary, args, cwd = source, timeout = 60000, allowedFailure = false) {
  const fd = fs.openSync(path.join(output, name + ".log"), "w", 0o600);
  const started = Date.now();
  const result = spawnSync(binary, args, {
    cwd,
    env,
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", fd, fd],
  });
  fs.closeSync(fd);
  summary.stages.push({
    name,
    exitCode: result.status,
    signal: result.signal,
    error: result.error?.message,
    durationMs: Date.now() - started,
  });
  save();
  assert.ok(!result.error && !result.signal, name + " did not complete");
  if (!allowedFailure) {
    assert.equal(result.status, 0, name + " failed");
  }
  return fs.readFileSync(path.join(output, name + ".log"), "utf8");
}
function git(args, cwd = source) {
  const result = spawnSync("git", args, { cwd, env, encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, "git source preflight failed");
  return result.stdout.trim();
}
function parseJson(text) {
  for (let index = text.indexOf("{"); index >= 0; index = text.indexOf("{", index + 1)) {
    try {
      return JSON.parse(text.slice(index));
    } catch {}
  }
  throw new Error("CLI returned no complete JSON object");
}
const hidden = [];
let gateway;
let gatewayFd;
try {
  assert.equal(git(["rev-parse", "HEAD"]), sourceSha);
  assert.equal(git(["status", "--porcelain"]), "");
  assert.equal(
    spawnSync("git", ["config", "--local", "--get-regexp", "http.*extraheader"], {
      cwd: source,
      env,
    }).status,
    1,
  );
  assert.equal(git(["rev-parse", "HEAD"], path.join(root, "prior")), priorProofSha);
  const paths = [
    "src/media/audio-transcode.ts",
    "src/media/audio-transcode.test.ts",
    "src/media/audio-transcode.native.test.ts",
  ];
  summary.reusedNativeProof = paths.map((file) => {
    const before = git(["rev-parse", priorProofSha + ":" + file], path.join(root, "prior"));
    const after = git(["rev-parse", sourceSha + ":" + file]);
    assert.equal(before, after, "native-proof source changed");
    return { file, blob: after };
  });
  const fixture = fs.readFileSync(path.join(source, "src/media/fixtures/tts-ten-segment.mp3"));
  const originalHash = createHash("sha256").update(fixture).digest("hex");
  assert.equal(originalHash, "7b2d8a3b1244383a4cfc3beaa57ba756c0d76c7d485fa80f927a458bdb60c0f0");
  command("dependencies", "pnpm", ["install", "--frozen-lockfile"], source, 900000);
  command("tooling-dependencies", "pnpm", ["install", "--frozen-lockfile"], tooling, 900000);
  command(
    "package",
    "node",
    [
      path.join(tooling, "scripts/package-openclaw-for-docker.mjs"),
      "--source-dir",
      source,
      "--runtime-only",
      "--bundle-plugin",
      "imessage",
      "--allow-unreleased-changelog",
      "--output-dir",
      path.join(isolated, "packed"),
    ],
    source,
    1800000,
  );
  const tarballs = fs
    .readdirSync(path.join(isolated, "packed"))
    .filter((name) => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1);
  const tarball = path.join(isolated, "packed", tarballs[0]);
  summary.packageSha256 = createHash("sha256").update(fs.readFileSync(tarball)).digest("hex");
  const install = path.join(isolated, "install");
  fs.writeFileSync(
    path.join(install, "package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  command(
    "install-package",
    "npm",
    ["install", "--no-audit", "--no-fund", "--package-lock=false", tarball],
    install,
    900000,
  );
  const packageRoot = path.join(install, "node_modules/openclaw");
  const cli = path.join(packageRoot, "openclaw.mjs");
  assert.ok(fs.existsSync(cli));
  summary.installedVersion = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json")),
  ).version;
  command("installed-version", process.execPath, [cli, "--version"], install);
  summary.claims.installedPackage = true;
  const plugin = path.join(install, "fixture-plugin");
  fs.mkdirSync(plugin);
  fs.copyFileSync(
    path.join(tooling, "scripts/goal24-audio-package-plugin.mjs"),
    path.join(plugin, "index.mjs"),
  );
  fs.writeFileSync(path.join(plugin, "fixture.mp3"), fixture);
  fs.writeFileSync(
    path.join(plugin, "package.json"),
    JSON.stringify({
      name: "goal24-audio",
      version: "1.0.0",
      private: true,
      type: "module",
      openclaw: { extensions: ["./index.mjs"] },
    }),
  );
  fs.writeFileSync(
    path.join(plugin, "openclaw.plugin.json"),
    JSON.stringify({
      id: "goal24-audio",
      name: "Synthetic audio package proof",
      channels: ["goal24audio"],
      contracts: { speechProviders: ["goal24-audio"] },
      activation: { onStartup: true },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  // Real missing-binary environment, not a mocked converter or PATH-only trick.
  for (const directory of [
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]) {
    const file = path.join(directory, "ffmpeg");
    if (!fs.existsSync(file)) {
      continue;
    }
    const stash = file + ".goal24-hidden-" + process.pid;
    fs.renameSync(file, stash);
    hidden.push({ file, stash });
  }
  for (const directory of [
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ]) {
    assert.equal(fs.existsSync(path.join(directory, "ffmpeg")), false);
  }
  summary.missingFfmpeg = { trustedDirectoriesChecked: 6, hiddenExecutables: hidden.length };
  const listener = net.createServer();
  await new Promise((resolve) => {
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve) => {
    listener.close(resolve);
  });
  const token = "synthetic-goal24-token";
  const config = path.join(isolated, "state", "openclaw.json");
  fs.writeFileSync(
    config,
    JSON.stringify({
      gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token } },
      plugins: {
        allow: ["goal24-audio"],
        load: { paths: [plugin] },
        entries: { "goal24-audio": { enabled: true } },
      },
      channels: { goal24audio: { enabled: true } },
      tts: { auto: "always", provider: "goal24-audio" },
    }),
  );
  env.OPENCLAW_CONFIG_PATH = config;
  gatewayFd = fs.openSync(path.join(output, "gateway.log"), "w", 0o600);
  gateway = spawn(
    process.execPath,
    [cli, "gateway", "run", "--allow-unconfigured", "--port", String(port), "--bind", "loopback"],
    { cwd: install, env, detached: true, stdio: ["ignore", gatewayFd, gatewayFd] },
  );
  const rpc = (name, method, params = {}, allowedFailure = false) =>
    command(
      name,
      process.execPath,
      [
        cli,
        "gateway",
        "call",
        method,
        "--url",
        "ws://127.0.0.1:" + port,
        "--token",
        token,
        "--params",
        JSON.stringify(params),
        "--json",
        "--timeout",
        "20000",
      ],
      install,
      60000,
      allowedFailure,
    );
  let ready = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    await delay(2000);
    assert.equal(gateway.exitCode, null, "installed Gateway exited before ready");
    try {
      const result = parseJson(rpc("health-" + attempt, "health", {}, true));
      if (result.ok === true) {
        ready = true;
        break;
      }
    } catch {}
  }
  assert.ok(ready, "installed Gateway did not become healthy");
  const synthesis = parseJson(rpc("tts", "goal24.audio"));
  assert.equal(synthesis.extension, ".mp3");
  assert.equal(synthesis.sha256, originalHash);
  assert.equal(synthesis.bytes, fixture.length);
  assert.equal(synthesis.provider, "goal24-audio");
  summary.synthesis = { ...synthesis, audioPath: "<isolated-media-store>" };
  assert.match(
    fs.readFileSync(path.join(output, "gateway.log"), "utf8"),
    /MP3-to-CAF conversion failed; keeping the original audio attachment./,
  );
  summary.claims.missingFfmpegFallback = true;
  parseJson(
    rpc("send", "send", {
      to: "synthetic-receiver",
      channel: "goal24audio",
      mediaUrl: synthesis.audioPath,
      message: "",
      idempotencyKey: randomUUID(),
    }),
  );
  const { sends } = parseJson(rpc("receipts", "goal24.audio", { action: "receipts" }));
  assert.equal(sends.length, 1);
  assert.equal(sends[0].sha256, originalHash);
  assert.equal(sends[0].extension, ".mp3");
  assert.equal(sends[0].bytes, fixture.length);
  summary.dispatch = sends[0];
  summary.claims.recordingAdapterDispatch = true;
  summary.outcome = "passed";
} catch (error) {
  summary.error = String(error);
  throw error;
} finally {
  if (gateway && gateway.exitCode === null) {
    try {
      process.kill(-gateway.pid, "SIGTERM");
    } catch {}
    for (let i = 0; i < 50 && gateway.exitCode === null; i++) {
      await delay(100);
    }
    if (gateway.exitCode === null) {
      try {
        process.kill(-gateway.pid, "SIGKILL");
      } catch {}
    }
  }
  if (gatewayFd !== undefined) {
    fs.closeSync(gatewayFd);
  }
  for (const { file, stash } of hidden.toReversed()) {
    fs.renameSync(stash, file);
  }
  summary.restoredFfmpeg = hidden.every(
    ({ file, stash }) => fs.existsSync(file) && !fs.existsSync(stash),
  );
  save();
}

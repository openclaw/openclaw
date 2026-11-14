import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  fixtureReceiptClientSource,
  type FixtureReceiptChannel,
  withinTest,
} from "openclaw/plugin-sdk/test-fixtures";
import * as tar from "tar";
import { expect } from "vitest";
import {
  readCrabboxRuntimeInstallation,
  type CrabboxRuntimeInstallationIdentity,
} from "../cli-runtime-api.js";
import type {
  CrabboxWorkerNodeEnrollment,
  CrabboxWorkerNodeRuntimePreparation,
} from "./crabbox-worker-node-enrollment.js";
import { createCrabboxNodeResumeScript } from "./crabbox-worker-node-process.js";

export type DesktopFixture = { enabled: boolean } & Partial<
  Record<"setup" | "display" | "dbus" | "runtimeDir", string>
>;

export const createWorkerArchiveFixture =
  (): CrabboxWorkerNodeRuntimePreparation["workerBundle"] => ({
    url: "https://gateway.example.test/__openclaw__/worker-bootstrap/artifacts/worker",
    token: "synthetic-worker-archive-token",
    sha256: "b".repeat(64),
    bytes: 100,
    packageRelativePath: `worker-artifacts/${"b".repeat(64)}.tgz`,
  });

export const createNodeBootstrapFixture = (
  overrides: Partial<CrabboxWorkerNodeEnrollment["nodeBootstrap"]> = {},
): CrabboxWorkerNodeEnrollment["nodeBootstrap"] => ({
  url: "https://gateway.example.test/__openclaw__/node-bootstrap/v1/artifact",
  token: "synthetic-bootstrap-token",
  sha256: "a".repeat(64),
  bytes: 100,
  openclawVersion: "2026.8.1",
  install: "npm",
  enabledPluginIds: ["demo"],
  ...overrides,
});

export async function readLaunch(
  stateDir: string,
  receipts: FixtureReceiptChannel,
  signal: AbortSignal,
) {
  // Enrollment writes node.pid before completing; the child publishes JSON before its receipt.
  const pid = fs.readFileSync(path.join(stateDir, "node.pid"), "utf8").trim();
  await withinTest(receipts.waitFor(stateDir, `launched:${pid}:ready`), signal);
  return JSON.parse(fs.readFileSync(path.join(stateDir, "launch.json"), "utf8")) as {
    build: string;
    cli: string;
    args: string[];
    token?: string;
    setupCode?: string;
    tool?: string;
    environment: Record<string, string>;
    enabledPlugins: string[];
  };
}

export async function createNodePackageFixture(
  makeTempDir: (prefix: string) => string,
  build: string,
  receipts: FixtureReceiptChannel,
  postinstall = "",
  install: "bundle" | "npm" = "npm",
): Promise<Buffer> {
  const root = makeTempDir("crabbox-bootstrap-package-");
  const packageRoot = path.join(root, "package");
  fs.mkdirSync(packageRoot);
  const files = {
    "package.json": JSON.stringify({
      name: "openclaw",
      version: "2026.8.1",
      scripts: { postinstall: "node install.cjs" },
    }),
    "install.cjs": `require("node:fs").writeFileSync("installed.json", JSON.stringify({ token: process.env.CRABBOX_WORKER_BOOTSTRAP_TOKEN, setupCode: process.env.CRABBOX_WORKER_SETUP_CODE, scriptsRan: true }));${postinstall}`,
    "openclaw.mjs": `import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
${fixtureReceiptClientSource(receipts.endpoint)}
${
  build === "same-node-resume"
    ? `import { runNodeHostLauncher } from "./node-host-launcher.mjs";
await runNodeHostLauncher({ entryPath: process.argv[1], packageRoot: path.dirname(process.argv[1]) });`
    : ""
}
const args = process.argv.slice(2);
const state = process.env.OPENCLAW_STATE_DIR;
if (args[0] === "--version") {
  console.log("OpenClaw 2026.8.1");
} else if (args[0] === "node" && args[1] === "identity") {
  console.log(JSON.stringify({ deviceId: fs.readFileSync(path.join(state, "saved-device"), "utf8") }));
} else if (args[0] === "plugins" && args[1] === "enable") {
  fs.appendFileSync(path.join(state, "activation.jsonl"), JSON.stringify({ runtimePublished: fs.existsSync(path.join(state, "runtime")) }) + "\\n");
  if (${JSON.stringify(build)} === "activation-failed") { console.error("plugin dependency missing"); process.exit(1); }
  for (const id of args.slice(2)) {
    if (${JSON.stringify(build)} === "verbose-activation") process.stdout.write("x".repeat(700_000));
    fs.appendFileSync(path.join(state, "enabled"), id + "\\n");
  }
} else {
  if (args[0] === "connect") fs.writeFileSync(path.join(state, "saved-device"), "device-test");
  process.title = "openclaw-connect";
  const enabledFile = path.join(state, "enabled");
  const enabledPlugins = fs.existsSync(enabledFile) ? fs.readFileSync(enabledFile, "utf8").trim().split("\\n") : [];
  fs.writeFileSync(path.join(state, "launch.json.tmp"), JSON.stringify({ build: ${JSON.stringify(build)}, args, cli: process.argv[1], token: process.env.CRABBOX_WORKER_BOOTSTRAP_TOKEN, setupCode: process.env.CRABBOX_WORKER_SETUP_CODE, tool: process.platform !== "win32" ? execFileSync("bootstrap-tool-fixture", {encoding:"utf8"}).trim() : undefined, environment: { DISPLAY: process.env.DISPLAY, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }, enabledPlugins }));
  // Existence signals readiness only after the child publishes complete JSON.
  fs.renameSync(path.join(state, "launch.json.tmp"), path.join(state, "launch.json"));
  sendReceipt(state, "launched:" + process.pid + ":ready");
  const desktopReady = path.join(process.env.HOME, "desktop-ready");
  if (fs.existsSync(desktopReady)) fs.writeFileSync(desktopReady, "ready\\n");
  setInterval(() => {}, 60000);
}
`,
  };
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(packageRoot, name), contents);
  }
  if (build === "same-node-resume") {
    // The private handoff runs the shipped launcher owner, not a fixture acknowledgement.
    for (const name of [
      "node-host-launcher.mjs",
      "cli-invocation.mjs",
      "cli-parent-lifetime.mjs",
      "node-runtime-env.mjs",
      "gateway-shutdown-budget.mjs",
    ]) {
      fs.copyFileSync(path.resolve(name), path.join(packageRoot, name));
    }
  }
  const tools = path.join(packageRoot, "dist", "worker-tools", "bin");
  fs.mkdirSync(tools, { recursive: true });
  fs.writeFileSync(path.join(tools, "bootstrap-tool-fixture"), "#!/bin/sh\necho verified-tool\n", {
    mode: 0o755,
  });
  if (install === "bundle") {
    const dependency = path.join(packageRoot, "node_modules/runtime-fixture");
    fs.mkdirSync(dependency, { recursive: true });
    fs.writeFileSync(
      path.join(dependency, "package.json"),
      JSON.stringify({
        name: "runtime-fixture",
        version: "1.0.0",
        type: "module",
        main: "index.js",
      }),
    );
    fs.writeFileSync(path.join(dependency, "index.js"), 'export const version = "2026.8.1";');
    fs.writeFileSync(
      path.join(packageRoot, "node-runtime.json"),
      JSON.stringify({
        buildId: "fixture-runtime-build",
        openclawVersion: "2026.8.1",
        install,
        platforms: [{ platform: process.platform, arch: process.arch, prefix: "" }],
      }),
    );
    const inventory: Array<{ path: string; size: number; mode: number; sha256: string }> = [];
    const visit = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(file);
        } else {
          const contents = fs.readFileSync(file);
          inventory.push({
            path: "package/" + path.relative(packageRoot, file).split(path.sep).join("/"),
            size: contents.length,
            mode: fs.statSync(file).mode & 0o777,
            sha256: createHash("sha256").update(contents).digest("hex"),
          });
        }
      }
    };
    visit(packageRoot);
    fs.writeFileSync(
      path.join(packageRoot, "node-runtime.manifest.json"),
      JSON.stringify(inventory),
    );
  }
  const archive = path.join(root, "package.tgz");
  await tar.create({ cwd: root, file: archive, gzip: true }, ["package"]);
  return fs.readFileSync(archive);
}

export async function expectSetupPhases(
  result: Promise<{ code: number | null; output: string }>,
  installation?: CrabboxRuntimeInstallationIdentity,
) {
  const completed = await result;
  expect(completed.code).toBe(0);
  if (installation) {
    readCrabboxRuntimeInstallation(completed.output, installation);
  }
  const lines = completed.output
    .trim()
    .split("\n")
    .filter((line) => !installation || !line.startsWith("openclaw.runtime-installed:"));
  // Successful bootstrap emits only the bounded diagnostics consumed by the Gateway.
  for (const line of lines) {
    expect(line).toMatch(
      /^(?:CRABBOX_PHASE:[a-z.-]{1,80}|CRABBOX_TIMING:[a-z.-]{1,80}:\d+|CRABBOX_WARNING:openclaw-bootstrap-unlocked-install:[a-zA-Z0-9 _-]+)$/,
    );
  }
  return lines
    .filter((line) => line.startsWith("CRABBOX_PHASE:"))
    .map((line) => line.slice("CRABBOX_PHASE:".length));
}

export async function runtimeManifestSha256(archive: Buffer): Promise<string | undefined> {
  let digest: string | undefined;
  const parser = tar.list({
    onReadEntry(entry) {
      if (entry.path !== "package/node-runtime.manifest.json") {
        return;
      }
      const hash = createHash("sha256");
      entry.on("data", (chunk: Buffer) => hash.update(chunk));
      entry.on("end", () => {
        digest = hash.digest("hex");
      });
    },
  });
  await pipeline(Readable.from([archive]), parser).catch(() => undefined);
  return digest;
}

export function expectFailure(
  result: { code: number | null; output: string },
  diagnosis: string | RegExp,
) {
  expect(result).toMatchObject({
    code: 1,
    output:
      typeof diagnosis === "string"
        ? expect.stringContaining(diagnosis)
        : expect.stringMatching(diagnosis),
  });
}
export function expectAbsent(...files: string[]) {
  for (const file of files) {
    expect(fs.existsSync(file), file).toBe(false);
  }
}
export function expectPrivate(launch: object) {
  expect(launch).not.toHaveProperty("token");
  expect(launch).not.toHaveProperty("setupCode");
}

export async function expectResumePublicationFailures({
  home,
  stateDir,
  initialPid,
  receipts,
  signal,
  resume,
  invoke,
}: {
  home: string;
  stateDir: string;
  initialPid: string;
  receipts: FixtureReceiptChannel;
  signal: AbortSignal;
  resume: (env: NodeJS.ProcessEnv) => { status: number | null; stderr: string };
  invoke: (phase: "inspect" | "launch") => { status: number | null; stderr: string };
}) {
  const pidFile = path.join(stateDir, "node.pid");
  const readText = (file: string) => fs.readFileSync(file, "utf8");
  expect(invoke("inspect").status).toBe(0);
  const runtimeLink = path.join(stateDir, "runtime");
  const savedRuntime = fs.readlinkSync(runtimeLink);
  try {
    fs.unlinkSync(runtimeLink);
    fs.symlinkSync(home, runtimeLink);
    expect(invoke("launch").stderr).toContain("saved runtime is missing or changed");
    expect(readText(pidFile)).toBe(initialPid);
  } finally {
    fs.unlinkSync(runtimeLink);
    fs.symlinkSync(savedRuntime, runtimeLink);
  }
  for (const failure of ["killed", "write-failed"]) {
    const childExitFile = path.join(home, `resume-child-exited-${failure}`);
    const childPidFile = path.join(home, `resume-child-pid-${failure}`);
    const preload = path.join(home, `resume-launch-loss-${failure}.cjs`);
    fs.writeFileSync(
      preload,
      `
const fs = require("node:fs");
const write = fs.writeFileSync;
if (process.argv.includes("--openclaw-node-host-resume-child")) {
  process.on("exit", () => {
    write(${JSON.stringify(childExitFile + ".tmp")}, String(process.pid));
    fs.renameSync(${JSON.stringify(childExitFile + ".tmp")}, ${JSON.stringify(childExitFile)});
  });
}
fs.writeFileSync = (file, data, ...rest) => {
  if (typeof file === "string" && (file === ${JSON.stringify(pidFile)} || file.startsWith(${JSON.stringify(pidFile + ".")}))) {
    write(${JSON.stringify(childPidFile)}, data);
    if (${JSON.stringify(failure)} === "killed") process.kill(process.pid, "SIGKILL");
    write(file, "");
    throw Object.assign(new Error("Synthetic interrupted PID write"), { code: "ENOSPC" });
  }
  return write(file, data, ...rest);
};
`,
    );
    // A temporary-file change is not completion; only the published entry contains the whole PID.
    const exited = Promise.withResolvers<void>();
    const watch = fs.watch(home, (_event, filename) => {
      if (filename === path.basename(childExitFile)) {
        exited.resolve();
      }
    });
    watch.once("error", exited.reject);
    let interruptedPid: number | undefined;
    try {
      const result = resume({ NODE_OPTIONS: `--require=${preload}` });
      expect(result.status, `${failure}: ${result.stderr}`).not.toBe(0);
      interruptedPid = Number(readText(childPidFile));
      const outcome = await withinTest(
        Promise.race([
          exited.promise.then(() => "stopped"),
          receipts.waitFor(stateDir, `launched:${interruptedPid}:ready`).then(() => "escaped"),
        ]),
        signal,
      );
      expect(outcome).toBe("stopped");
      expect(readText(childExitFile)).toBe(String(interruptedPid));
      expect(readText(pidFile)).toBe(initialPid);
    } finally {
      watch.close();
      if (interruptedPid) {
        try {
          process.kill(-interruptedPid, "SIGKILL");
        } catch (error) {
          expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
        }
      }
    }
  }
}

export function createNodeResumeFixture({
  home,
  leaseId,
  nodeBootstrap,
  signal,
}: {
  home: string;
  leaseId: string;
  nodeBootstrap: CrabboxWorkerNodeEnrollment["nodeBootstrap"];
  signal: AbortSignal;
}) {
  const request = {
    leaseId,
    deviceId: "device-test",
    nodeBootstrapSha256: nodeBootstrap.sha256,
    openclawVersion: nodeBootstrap.openclawVersion,
    platform: "linux",
    profile: {},
    signal,
    assertCurrent() {},
  };
  const invoke = (
    phase: "inspect" | "launch",
    overrides: Partial<typeof request> = {},
    env: NodeJS.ProcessEnv = {},
  ) =>
    spawnSync("/bin/sh", [], {
      input: createCrabboxNodeResumeScript({ ...request, ...overrides }, phase),
      env: { HOME: home, PATH: process.env.PATH, ...env },
      encoding: "utf8",
      timeout: 10_000,
    });
  const resume = (overrides: Partial<typeof request> = {}, env: NodeJS.ProcessEnv = {}) => {
    const inspected = invoke("inspect", overrides, env);
    return inspected.status === 0 ? invoke("launch", overrides, env) : inspected;
  };
  return { invoke, resume };
}

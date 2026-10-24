import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import {
  PROXY_FIXTURE_CERTIFICATE,
  PROXY_FIXTURE_KEY,
  useAutoCleanupTempDirTracker,
} from "openclaw/plugin-sdk/test-env";
import {
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
  withinTest,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as processRunner from "./crabbox-process.js";
import { crabboxState } from "./crabbox-state.test-support.js";
import {
  createCrabboxNodeEnrollmentSetup,
  createCrabboxNodeRuntimeSetup,
  type CrabboxWorkerNodeEnrollment,
} from "./crabbox-worker-node-enrollment.js";
import {
  createNodeBootstrapFixture,
  createNodePackageFixture,
  expectSetupPhases,
  readLaunch,
  type DesktopFixture,
} from "./crabbox-worker-node-enrollment.test-support.js";
import { resolveCrabboxProvisionProfile } from "./crabbox-worker-profile.js";
import { commandResult } from "./crabbox-worker-provider.test-support.js";
import { SCRUB_WORKER_STATE } from "./crabbox-worker-warm-image-scrub.js";
import { openCrabboxWarmImageStore } from "./crabbox-worker-warm-image-store.js";
import { createCrabboxWarmImageManager } from "./crabbox-worker-warm-image.js";
import { PROFILE, checkpointResult, jsonResult } from "./crabbox-worker-warm-image.test-support.js";

let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(() => receipts.close());

const cleanups: Array<() => Promise<void> | void> = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanupDirectories) => {
  afterEach(async () => {
    try {
      for (const cleanup of cleanups.splice(0).toReversed()) {
        await cleanup();
      }
    } finally {
      cleanupDirectories();
    }
  });
});
const leaseId = "cbx_bootstrap_test";
const setupCode = "synthetic-enrollment-credential";
const runtimeRoot = (home: string) => path.join(home, ".openclaw-worker", "node-runtimes");
const runtimePackage = (home: string, digest: string) =>
  path.join(runtimeRoot(home), digest, "node_modules", "openclaw");
const readJson = (...parts: string[]): unknown =>
  JSON.parse(fs.readFileSync(path.join(...parts), "utf8"));
const readText = (...parts: string[]) => fs.readFileSync(path.join(...parts), "utf8");
const phases = (names: string) => names.split(" ").map((name) => `openclaw-bootstrap-${name}`);
const loginEnvironment = {
  DISPLAY: ":0",
  DBUS_SESSION_BUS_ADDRESS: "wrong-login-session",
  XDG_RUNTIME_DIR: "/run/wrong",
};
const desktopEnvironment = (runtimeDir = "/run/fixture") => ({
  DISPLAY: ":99",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/fixture/bus",
  ...(runtimeDir ? { XDG_RUNTIME_DIR: runtimeDir } : {}),
});
function expectFailure(
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
function expectAbsent(...files: string[]) {
  for (const file of files) {
    expect(fs.existsSync(file), file).toBe(false);
  }
}
function expectPrivate(launch: object) {
  expect(launch).not.toHaveProperty("token");
  expect(launch).not.toHaveProperty("setupCode");
}

const packageFixture = (build: string, postinstall = "") =>
  createNodePackageFixture((prefix) => tempDirs.make(prefix), build, receipts, postinstall);

function testHome() {
  const home = fs.realpathSync(tempDirs.make("crabbox-bootstrap-home-"));
  const stateDir = path.join(home, ".openclaw", "cloud-workers", leaseId);
  const stop = async () => {
    const pidFile = path.join(stateDir, "node.pid");
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, "utf8"));
      try {
        process.kill(-pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw error;
        }
      }
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow("ESRCH"), {
        timeout: 5_000,
      });
    }
  };
  cleanups.push(stop);
  return { home, stateDir, stop };
}

async function serveArtifact(
  archive: Buffer,
  options: {
    tls?: boolean;
    redirect?: boolean;
    truncate?: boolean;
    resetBeforeHeaders?: boolean;
    resetBeforeTls?: boolean;
    statusCodes?: number[];
    hold?: Promise<void>;
  } = {},
) {
  const tls =
    options.tls && !options.resetBeforeTls
      ? { cert: PROXY_FIXTURE_CERTIFICATE, key: PROXY_FIXTURE_KEY }
      : undefined;
  const authorizations: Array<string | undefined> = [];
  const requested = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const handle: http.RequestListener = (request, response) => {
    authorizations.push(request.headers.authorization);
    requested.resolve();
    const statusCode = options.statusCodes?.[authorizations.length - 1];
    if (statusCode) {
      response.writeHead(statusCode);
      response.end();
      return;
    }
    if (options.resetBeforeHeaders) {
      // End the connection before headers in every host runtime; the child must
      // diagnose the peer loss without relying on resetAndDestroy support.
      request.socket.destroy();
      return;
    }
    if (options.redirect) {
      response.writeHead(302, { location: "https://untrusted.example.test/artifact" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-length": archive.length });
    if (options.truncate) {
      // Truncate after headers without retained bytes: one persisted byte resets the
      // consecutive-failure budget and makes the request count scheduler-dependent.
      response.end();
      return;
    }
    if (options.hold) {
      void options.hold.then(() => response.end(archive));
    } else {
      response.end(archive);
    }
  };
  const server = options.resetBeforeTls
    ? net.createServer((socket) => socket.once("data", () => socket.resetAndDestroy()))
    : tls
      ? https.createServer(tls, handle)
      : http.createServer(handle);
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => {
      sockets.delete(socket);
      closed.resolve();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected TCP artifact server");
  }
  const nodeBootstrap = createNodeBootstrapFixture({
    url: `${options.tls ? "https" : "http"}://127.0.0.1:${address.port}/artifact`,
    sha256: createHash("sha256").update(archive).digest("hex"),
    bytes: archive.length,
    ...(tls ? { tlsFingerprint: new X509Certificate(tls.cert).fingerprint256 } : {}),
  });
  return { nodeBootstrap, authorizations, requested: requested.promise, closed: closed.promise };
}

const servePackage = async (
  build: string,
  options?: Parameters<typeof serveArtifact>[1],
  postinstall = "",
) => serveArtifact(await packageFixture(build, postinstall), options);
const workerBundleFor = (nodeBootstrap: CrabboxWorkerNodeEnrollment["nodeBootstrap"]) => ({
  ...nodeBootstrap,
  packageRelativePath: `worker-artifacts/${nodeBootstrap.sha256}.tgz`,
});

async function enroll(
  home: string,
  nodeBootstrap: CrabboxWorkerNodeEnrollment["nodeBootstrap"],
  desktop?: DesktopFixture,
  runtimeOnly = false,
  workerBundle?: CrabboxWorkerNodeEnrollment["nodeBootstrap"] & { packageRelativePath: string },
  options?: { credentials?: string; timeoutMs?: number; signal?: AbortSignal },
) {
  const bin = path.join(home, "bin");
  const proc = path.join(home, "proc");
  if (desktop) {
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.join(proc, "123"), { recursive: true });
    fs.writeFileSync(path.join(home, "desktop.env"), "CRABBOX_DESKTOP_ENV=xfce\nDISPLAY=:99\n");
    fs.writeFileSync(
      path.join(proc, "123", "environ"),
      [
        `DISPLAY=${desktop.display ?? ":99"}`,
        `DBUS_SESSION_BUS_ADDRESS=${desktop.dbus ?? "unix:path=/run/fixture/bus"}`,
        `XDG_RUNTIME_DIR=${desktop.runtimeDir ?? "/run/fixture"}`,
        "UNRELATED_DESKTOP_VALUE=do-not-export",
        "",
      ].join("\0"),
    );
    fs.writeFileSync(
      path.join(bin, "pgrep"),
      `#!/bin/sh
set -eu
[ "$*" = "-u $(id -u) -x xfce4-session" ]
[ -z "\${CRABBOX_WORKER_BOOTSTRAP_TOKEN-}" ]
[ -z "\${CRABBOX_WORKER_SETUP_CODE-}" ]
echo 123
`,
      { mode: 0o700 },
    );
  }
  const setup = runtimeOnly
    ? createCrabboxNodeRuntimeSetup({ leaseId, nodeBootstrap, workerBundle: workerBundle! })
    : createCrabboxNodeEnrollmentSetup({
        leaseId,
        desktop: desktop?.enabled,
        desktopSetup: desktop?.setup,
        enrollment: {
          mode: "connect",
          setupCode,
          setupId: "bootstrap-test",
          openclawVersion: "2026.8.1",
          nodeBootstrap,
          displayName: "Bootstrap test",
          waitForDeviceId: async () => "device-test",
        },
      });
  expect(setup.command).not.toContain(nodeBootstrap.token);
  expect(setup.command).not.toContain(setupCode);
  const hooks = path.join(home, "bootstrap-test-hooks.cjs");
  // Observe real npm launches even when Linux prepends Node's directory to PATH.
  fs.writeFileSync(
    hooks,
    `require("node:timers/promises").setTimeout = async () => {};
const childProcess = require("node:child_process");
const spawn = childProcess.spawn;
childProcess.spawn = (command, args, options) => {
  if (command === "npm") require("node:fs").appendFileSync(${JSON.stringify(path.join(home, "npm-calls"))}, args[0] + "\\n");
  return spawn(command, args, options);
};
`,
  );
  const child = spawn("/bin/sh", [], {
    env: {
      HOME: home,
      NODE_OPTIONS: `--require ${JSON.stringify(hooks)}`,
      PATH: `${bin}:${process.env.PATH}`,
      ...(desktop ? loginEnvironment : {}),
      ...setup.forwardedEnv,
      ...(options?.credentials ? { CRABBOX_WORKER_BOOTSTRAP_TOKEN: options.credentials } : {}),
      // Exercise the installer overriding an inherited package-manager default.
      NPM_CONFIG_IGNORE_SCRIPTS: "true",
    },
    detached: true,
    stdio: "pipe",
  });
  const timeout = options?.timeoutMs
    ? setTimeout(() => {
        if (child.pid) {
          process.kill(-child.pid, "SIGKILL");
        }
      }, options.timeoutMs)
    : undefined;
  const output: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
  // Replace only OS fixture roots; the generated bootstrap and credential flow execute unchanged.
  child.stdin.end(
    setup.command
      .replaceAll("/var/lib/crabbox/desktop.env", path.join(home, "desktop.env"))
      .replaceAll("/proc/$process_pid/environ", `${proc}/$process_pid/environ`),
  );
  const closed = once(child, "close");
  try {
    const [code] = await (options?.signal ? withinTest(closed, options.signal) : closed);
    return { code, output: Buffer.concat(output).toString("utf8") };
  } finally {
    clearTimeout(timeout);
    const active = child.exitCode === null && child.signalCode === null;
    if (options?.signal?.aborted && child.pid && active) {
      // The enrollment shell owns desktop setup; stop its group before releasing the FIFO.
      process.kill(-child.pid, "SIGKILL");
    }
    await closed;
  }
}

describe.skipIf(process.platform === "win32")("source node bootstrap", () => {
  it.each(["present", "absent", "rejected", "download failure"])(
    "installs a prepared runtime with a %s project lock and keeps fallback available",
    async (mode) => {
      const bytes = await packageFixture("locked-runtime");
      const runtime = await serveArtifact(bytes);
      const lock =
        mode === "rejected"
          ? {}
          : {
              lockfileVersion: 3,
              requires: true,
              packages: {
                "": { dependencies: { openclaw: "file:../node-runtime.tgz" } },
                "node_modules/openclaw": {
                  version: "2026.8.1",
                  resolved: "file:../node-runtime.tgz",
                  integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"),
                  hasInstallScript: true,
                },
              },
            };
      const served = await serveArtifact(
        Buffer.from(JSON.stringify(lock)),
        mode === "download failure" ? { statusCodes: [403] } : undefined,
      );
      const nodeBootstrap = {
        ...runtime.nodeBootstrap,
        ...(mode === "absent" ? {} : { installLock: served.nodeBootstrap }),
      };
      // Two fresh machines consume the same prepared archive and project lock.
      for (let start = 0; start < (mode === "present" ? 2 : 1); start++) {
        const { home } = testHome();
        const calls = path.join(home, "npm-calls");
        const worker = await serveArtifact(Buffer.from("worker archive"));
        const result = await enroll(
          home,
          nodeBootstrap,
          undefined,
          true,
          workerBundleFor(worker.nodeBootstrap),
        );
        expect(result.code, result.output).toBe(0);
        expect(readJson(runtimePackage(home, nodeBootstrap.sha256), "installed.json")).toEqual({
          scriptsRan: true,
        });
        expect(readText(calls).trim().split("\n")).toEqual(
          mode === "present" ? ["ci"] : mode === "rejected" ? ["ci", "install"] : ["install"],
        );
        expect(result.output.includes("CRABBOX_WARNING:openclaw-bootstrap-unlocked-install:")).toBe(
          mode !== "present",
        );
        expect(result.output).toMatch(
          /CRABBOX_TIMING:openclaw-bootstrap-installation-and-worker-download:\d+/,
        );
        expect(result.output).not.toContain(served.nodeBootstrap.token);
      }
      expect(served.authorizations).toHaveLength(
        mode === "present" ? 2 : mode === "absent" ? 0 : 1,
      );
    },
  );

  it("reuses a completed runtime upgrade on the next fresh warm child", async () => {
    const root = fs.realpathSync(tempDirs.make("warm-runtime-repeat-proof-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "gateway-state"));
    const oldArtifact = await servePackage("older-runtime");
    const currentArtifact = await servePackage("current-runtime");
    expect(oldArtifact.nodeBootstrap.sha256).not.toBe(currentArtifact.nodeBootstrap.sha256);
    const profile = resolveCrabboxProvisionProfile(PROFILE, undefined).profile;
    const homes = new Map<string, string>();
    const snapshots = new Map<string, string>();
    let snapshotCount = 0;
    const forkChoices: string[] = [];
    const homeFor = (id: string) => {
      const home = path.join(root, id);
      fs.mkdirSync(home, { recursive: true });
      homes.set(id, home);
      return home;
    };
    const context = (id: string, digest = oldArtifact.nodeBootstrap.sha256) => ({
      nodeRuntimeIdentity: { nodeBootstrapSha256: digest, executionMode: "worker-turn" as const },
      binary: "crabbox",
      id,
      provider: "aws",
      profile,
      slug: id,
      timeoutMs: () => 60_000,
    });
    const hasRuntime = (id: string, digest: string) =>
      fs.existsSync(path.join(runtimeRoot(homes.get(id)!), digest));
    vi.spyOn(processRunner, "runCrabboxProcess").mockImplementation(async (argv, options) => {
      if (argv[1] === "warmup") {
        homeFor(argv[argv.indexOf("--lease-id") + 1]!);
      }
      if (argv[1] === "run") {
        const id = argv[argv.indexOf("--id") + 1]!;
        const home = homes.get(id)!;
        execFileSync("/bin/sh", [], {
          input: options?.input,
          cwd: home,
          env: { HOME: home, PATH: process.env.PATH },
        });
      }
      if (argv[1] === "checkpoint" && argv[2] === "create") {
        const id = argv[argv.indexOf("--id") + 1]!;
        const checkpoint = `chk_fixture_${++snapshotCount}`;
        const snapshot = path.join(root, checkpoint);
        fs.cpSync(runtimeRoot(homes.get(id)!), snapshot, { recursive: true });
        snapshots.set(checkpoint, snapshot);
        return checkpointResult(checkpoint, id, "completed");
      }
      if (argv[1] === "checkpoint" && argv[2] === "delete") {
        fs.rmSync(snapshots.get(argv[3]!)!, { recursive: true });
        snapshots.delete(argv[3]!);
      }
      if (argv[1] === "checkpoint" && argv[2] === "inspect") {
        return jsonResult({
          localState: "metadata_available",
          providerState: "completed",
          nextAction: "fork_or_delete",
        });
      }
      if (argv[1] === "checkpoint" && argv[2] === "fork") {
        const checkpoint = argv[3]!;
        const id = argv[argv.indexOf("--lease-id") + 1]!;
        const home = homeFor(id);
        fs.cpSync(snapshots.get(checkpoint)!, runtimeRoot(home), { recursive: true });
        forkChoices.push(checkpoint);
        return jsonResult({
          checkpointId: checkpoint,
          leaseId: id,
          provider: "aws",
          slug: id,
          workdir: "/workspace",
        });
      }
      return commandResult();
    });
    const manager = createCrabboxWarmImageManager({
      state: crabboxState,
      prepareCapture: async () => {},
      warn: (message) => {
        throw new Error(message);
      },
    });
    const initial = context("cbx_initial");
    await manager.allocate(initial);
    await expectSetupPhases(
      enroll(homes.get(initial.id)!, oldArtifact.nodeBootstrap, undefined, true),
    );
    await manager.markEnrolled(initial.id);
    expect(await manager.capture(initial)).toBe(true);
    await manager.release(initial);
    fs.rmSync(homes.get(initial.id)!, { recursive: true });
    const originalCheckpoint = (await openCrabboxWarmImageStore(crabboxState).entries())[0]!.value
      .image!.checkpointId;

    const upgraded = context("cbx_upgraded", currentArtifact.nodeBootstrap.sha256);
    expect(await manager.allocate(upgraded)).toEqual({
      kind: "checkpoint",
      checkpointId: originalCheckpoint,
    });
    const upgradePhases = await expectSetupPhases(
      enroll(homes.get(upgraded.id)!, currentArtifact.nodeBootstrap, undefined, true),
    );
    expect(upgradePhases).toContain("openclaw-bootstrap-installation");
    expect(hasRuntime(upgraded.id, currentArtifact.nodeBootstrap.sha256)).toBe(true);
    await manager.markEnrolled(upgraded.id);
    const refreshed = await manager.capture(upgraded);
    await manager.release(upgraded);
    fs.rmSync(homes.get(upgraded.id)!, { recursive: true });
    const retainedCheckpoint = (await openCrabboxWarmImageStore(crabboxState).entries())[0]!.value
      .image!.checkpointId;

    const next = context("cbx_next", currentArtifact.nodeBootstrap.sha256);
    const nextChoice = await manager.allocate(next);
    const currentWasCached = hasRuntime(next.id, currentArtifact.nodeBootstrap.sha256);
    const repeatPhases = await expectSetupPhases(
      enroll(homes.get(next.id)!, currentArtifact.nodeBootstrap, undefined, true),
    );
    await manager.release(next);
    expect(refreshed).toBe(true);
    expect(retainedCheckpoint).not.toBe(originalCheckpoint);
    expect(forkChoices).toEqual([originalCheckpoint, retainedCheckpoint]);
    expect(nextChoice).toEqual({ kind: "checkpoint", checkpointId: retainedCheckpoint });
    expect(currentWasCached).toBe(true);
    expect(repeatPhases).not.toContain("openclaw-bootstrap-installation");
    const entries = await openCrabboxWarmImageStore(crabboxState).entries();
    expect(entries).toHaveLength(1);
    expect(Object.keys(entries[0]!.value.allocations)).toEqual([]);
  }, 60_000);

  it("rejects an occupied runtime file before plugin activation", async () => {
    const { home, stateDir } = testHome();
    fs.mkdirSync(stateDir, { recursive: true });
    const retained = path.join(stateDir, "runtime");
    fs.writeFileSync(retained, "retained fixture");
    const { nodeBootstrap } = await servePackage("occupied");
    const result = await enroll(home, nodeBootstrap);
    expectFailure(result, "runtime pointer is occupied");
    expect(readText(retained)).toBe("retained fixture");
    expectAbsent(path.join(stateDir, "activation.jsonl"), path.join(stateDir, "node.pid"));
  });

  it("leaves the runtime pointer unpublished when plugin activation fails", async () => {
    const { home, stateDir } = testHome();
    const { nodeBootstrap } = await servePackage("activation-failed");
    const result = await enroll(home, nodeBootstrap);
    expectFailure(
      result,
      /could not enable plugins demo: exit code 1, signal none: plugin dependency missing/u,
    );
    expectAbsent(path.join(stateDir, "runtime"), path.join(stateDir, "node.pid"));
    expect(readJson(stateDir, "activation.jsonl")).toEqual({ runtimePublished: false });
  });

  it("rejects malformed forwarded credentials without disclosing their value", async () => {
    const { home } = testHome();
    const { nodeBootstrap, authorizations } = await servePackage("bad-credentials");
    const credentials = "synthetic-worker-secret-not-json";
    const result = await enroll(home, nodeBootstrap, undefined, false, undefined, { credentials });
    expectFailure(result, "credential format is invalid");
    expect(result.output).not.toContain("synthetic");
    expect(authorizations).toEqual([]);
  });

  it("rejects a FIFO prepared archive without a blocking read or another download", async () => {
    const { home } = testHome();
    const { nodeBootstrap } = await servePackage("fifo");
    const worker = await serveArtifact(Buffer.from("synthetic worker archive"));
    const workerBundle = workerBundleFor(worker.nodeBootstrap);
    await expectSetupPhases(enroll(home, nodeBootstrap, undefined, true, workerBundle));
    const archivePath = path.join(
      runtimePackage(home, nodeBootstrap.sha256),
      workerBundle.packageRelativePath,
    );
    fs.unlinkSync(archivePath);
    execFileSync("mkfifo", [archivePath]);

    const result = await enroll(home, nodeBootstrap, undefined, true, workerBundle, {
      timeoutMs: 3_000,
    });

    expectFailure(result, "archive path or length is unsafe");
    expect(worker.authorizations).toHaveLength(1);
  }, 30_000);

  it("prepares an exact runtime without node identity, then enrolls and reuses its warm artifact", async ({
    signal,
  }) => {
    const { home, stateDir, stop } = testHome();
    const installed = await serveArtifact(Buffer.from("installed"));
    const { nodeBootstrap, authorizations } = await servePackage(
      "first",
      undefined,
      `require("node:http").get(${JSON.stringify(installed.nodeBootstrap.url)}, (response) => response.resume());`,
    );
    const workerBytes = Buffer.from("synthetic standalone worker archive");
    const workerResponse = Promise.withResolvers<void>();
    const worker = await serveArtifact(workerBytes, { hold: workerResponse.promise });
    const workerBundle = workerBundleFor(worker.nodeBootstrap);
    const preparation = expectSetupPhases(
      enroll(home, nodeBootstrap, undefined, true, workerBundle),
    );
    cleanups.push(async () => {
      workerResponse.resolve();
      await preparation;
    });
    try {
      await installed.requested;
      expectAbsent(
        path.join(runtimeRoot(home), nodeBootstrap.sha256),
        path.join(home, ".openclaw"),
      );
    } finally {
      workerResponse.resolve();
      await preparation;
    }
    expect(await preparation).toEqual(
      expect.arrayContaining(
        phases(
          "preparation download-connection download-http-response download-body installation-and-worker-download runtime-verification worker-archive-publication complete",
        ),
      ),
    );
    expectAbsent(path.join(home, ".openclaw"));
    expect(fs.readdirSync(runtimeRoot(home))).toEqual([nodeBootstrap.sha256]);
    const preparedPackage = runtimePackage(home, nodeBootstrap.sha256);
    expect(readJson(preparedPackage, "installed.json")).toEqual({ scriptsRan: true });
    expect(authorizations).toEqual([`Bearer ${nodeBootstrap.token}`]);
    expect(fs.readFileSync(path.join(preparedPackage, workerBundle.packageRelativePath))).toEqual(
      workerBytes,
    );
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "setup-code"), setupCode);
    fs.mkdirSync(path.join(home, ".crabbox", "env"), { recursive: true });
    fs.writeFileSync(path.join(home, ".crabbox", "env", "forwarded"), workerBundle.token);
    const scrubTmp = path.join(home, "scrub-tmp");
    fs.mkdirSync(scrubTmp);
    // The script's Linux /tmp root belongs to the synthetic worker, not this host.
    execFileSync("sh", ["-c", SCRUB_WORKER_STATE.replace('"/tmp"', JSON.stringify(scrubTmp))], {
      cwd: home,
      env: { HOME: home, PATH: process.env.PATH, TMPDIR: scrubTmp },
    });
    expectAbsent(stateDir, path.join(home, ".crabbox", "env"));
    expect(fs.readdirSync(path.join(preparedPackage, "worker-artifacts"))).toEqual([
      `${workerBundle.sha256}.tgz`,
    ]);
    expect(fs.readFileSync(path.join(preparedPackage, workerBundle.packageRelativePath))).toEqual(
      workerBytes,
    );
    expect(
      await expectSetupPhases(enroll(home, nodeBootstrap, undefined, true, workerBundle)),
    ).toEqual(
      phases(
        "preparation runtime-verification worker-archive-verification worker-archive-publication complete",
      ),
    );
    expect(worker.authorizations).toEqual([`Bearer ${workerBundle.token}`]);
    expect(await expectSetupPhases(enroll(home, nodeBootstrap))).toEqual(
      phases("preparation runtime-verification activation plugin-activation node-launch complete"),
    );
    const launch = await readLaunch(stateDir, receipts, signal);
    expect(launch).toMatchObject({
      build: "first",
      args: [
        "connect",
        "--target-file",
        path.join(stateDir, "setup-code"),
        "--ephemeral",
        "--display-name",
        "Bootstrap test",
      ],
    });
    if (process.platform !== "win32") {
      expect(launch.tool).toBe("verified-tool");
    }
    expectPrivate(launch);
    expect(launch.cli).toContain(`/node-runtimes/${nodeBootstrap.sha256}/`);
    expect(readJson(path.dirname(launch.cli), "installed.json")).toEqual({ scriptsRan: true });
    expect(readText(stateDir, "enabled")).toBe("demo\n");
    expect(readJson(stateDir, "activation.jsonl")).toEqual({ runtimePublished: false });
    expect(fs.realpathSync(path.join(stateDir, "runtime"))).toBe(
      path.dirname(path.dirname(path.dirname(launch.cli))),
    );
    expect(fs.readdirSync(stateDir).some((name) => name.startsWith("node-bootstrap-"))).toBe(false);
    expect(authorizations).toEqual([`Bearer ${nodeBootstrap.token}`]);
    await stop();
    fs.rmSync(path.join(stateDir, "launch.json"));
    await expectSetupPhases(enroll(home, nodeBootstrap));
    expect((await readLaunch(stateDir, receipts, signal)).cli).toBe(launch.cli);
    expect(authorizations).toHaveLength(1);
  }, 30_000);

  it.each(["worker download", "npm installation"])(
    "settles started work after %s fails before removing staging files",
    async (failure) => {
      const { home } = testHome();
      const postinstallResponse = Promise.withResolvers<void>();
      const postinstall = await serveArtifact(Buffer.from("finish"), {
        hold: postinstallResponse.promise,
      });
      const finished = path.join(home, "postinstall-complete");
      const { nodeBootstrap } = await servePackage(
        "preparation-failure",
        undefined,
        `
require("node:http").get(${JSON.stringify(postinstall.nodeBootstrap.url)}, (response) => {
  response.resume();
  response.once("end", () => {
    require("node:fs").writeFileSync("last-install-write", "complete");
    require("node:fs").writeFileSync(${JSON.stringify(finished)}, "complete");
    if (${JSON.stringify(failure)} === "npm installation") process.exit(17);
  });
});`,
      );
      const workerResponse = Promise.withResolvers<void>();
      const worker = await serveArtifact(Buffer.from("synthetic worker archive"), {
        hold: workerResponse.promise,
      });
      const workerBundle = {
        ...workerBundleFor(worker.nodeBootstrap),
        ...(failure === "worker download" ? { bytes: worker.nodeBootstrap.bytes + 1 } : {}),
      };
      const preparation = enroll(home, nodeBootstrap, undefined, true, workerBundle);
      cleanups.push(async () => {
        workerResponse.resolve();
        postinstallResponse.resolve();
        await preparation;
      });
      try {
        await Promise.all([postinstall.requested, worker.requested]);
        if (failure === "worker download") {
          workerResponse.resolve();
          await postinstall.closed;
          await preparation;
        } else {
          postinstallResponse.resolve();
          await worker.closed;
        }
      } finally {
        workerResponse.resolve();
        postinstallResponse.resolve();
        await preparation;
      }
      expectFailure(
        await preparation,
        failure === "worker download"
          ? "archive length does not match the Gateway"
          : "package installation failed (exit code 17)",
      );
      expect(fs.existsSync(finished)).toBe(failure === "npm installation");
      expect(fs.readdirSync(runtimeRoot(home))).toEqual([]);
    },
    30_000,
  );

  it.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
    "reuses only a live process with the exact artifact and invocation",
    async ({ signal }) => {
      const { home, stateDir } = testHome();
      const { nodeBootstrap, authorizations } = await servePackage("first");
      await expectSetupPhases(enroll(home, nodeBootstrap));
      const launch = await readLaunch(stateDir, receipts, signal);
      const pid = readText(stateDir, "node.pid");
      await expectSetupPhases(enroll(home, nodeBootstrap));
      expect(readText(stateDir, "node.pid")).toBe(pid);
      expect(authorizations).toHaveLength(1);
      if (process.platform === "darwin") {
        const launchFile = path.join(stateDir, "node-launch.json");
        const record = JSON.parse(readText(launchFile));
        expect(record).toMatchObject({
          pid: Number(pid),
          stateDir,
          cli: launch.cli,
        });
        expect(fs.statSync(launchFile).mode & 0o777).toBe(0o600);
        expect(fs.statSync(stateDir).mode & 0o777).toBe(0o700);
        expect(record.startTime).toBe(
          execFileSync("ps", ["-o", "lstart=", "-p", pid.trim()], { encoding: "utf8" })
            .trim()
            .replace(/\s+/g, " "),
        );
        fs.writeFileSync(
          launchFile,
          JSON.stringify({ ...record, startTime: "different process start" }),
        );
        expectFailure(await enroll(home, nodeBootstrap), "release and reprovision the worker");
        fs.writeFileSync(launchFile, JSON.stringify(record));
      }
      const rejected = await enroll(home, { ...nodeBootstrap, sha256: "b".repeat(64) });
      expectFailure(rejected, "different bootstrap artifact or invocation");
      expect(readText(stateDir, "node.pid")).toBe(pid);
    },
    30_000,
  );

  it.for([
    { failures: 1, expectedCode: 0, requests: 2 },
    { failures: 10, expectedCode: 1, requests: 9 },
  ])(
    "handles $failures transient HTTP 530 responses during enrollment",
    async ({ failures, expectedCode, requests }, { signal }) => {
      const { home, stateDir } = testHome();
      const { nodeBootstrap, authorizations } = await servePackage("edge-retry", {
        statusCodes: Array(failures).fill(530),
      });
      const result = await enroll(home, nodeBootstrap, undefined, false, undefined, { signal });
      expect(result.code, result.output).toBe(expectedCode);
      expect(authorizations).toEqual(Array(requests).fill(`Bearer ${nodeBootstrap.token}`));
      if (expectedCode === 0) {
        expect(await readLaunch(stateDir, receipts, signal)).toMatchObject({ build: "edge-retry" });
      } else {
        expect(result.output).toContain(
          "HTTP 530 (download attempt 9; 9 consecutive no-progress failures)",
        );
        expect(fs.existsSync(path.join(stateDir, "node.pid"))).toBe(false);
      }
    },
  );

  it.each([
    ["digest", "integrity verification"],
    ["length", "length does not match"],
    ["redirect", /download HTTP response failed from [^\s]+:.*HTTP 302/],
    ["http-reset", "download HTTP response failed (ECONNRESET)"],
    ["tls-reset", "download TLS failed (ECONNRESET)"],
    ["truncated", /download body failed \(ECONNRESET\) from [^\s]+: aborted/],
  ] as const)(
    "identifies bootstrap %s failure before installing or starting a node",
    async (failure, diagnosis) => {
      const { home, stateDir } = testHome();
      const archive = await packageFixture("first");
      const { nodeBootstrap, authorizations } = await serveArtifact(archive, {
        redirect: failure === "redirect",
        truncate: failure === "truncated",
        resetBeforeHeaders: failure === "http-reset",
        resetBeforeTls: failure === "tls-reset",
        tls: failure === "tls-reset",
      });
      const result = await enroll(home, {
        ...nodeBootstrap,
        url: nodeBootstrap.url + "/synthetic-url-token",
        ...(failure === "digest" ? { sha256: "f".repeat(64) } : {}),
        ...(failure === "length" ? { bytes: archive.length + 1 } : {}),
      });
      expect(result.code).toBe(1);
      expect(result.output).toMatch(diagnosis);
      expect(result.output).not.toContain(nodeBootstrap.token);
      expect(result.output).not.toContain(setupCode);
      expect(result.output).not.toContain("synthetic-url-token");
      if (failure === "tls-reset") {
        const origin = new URL(nodeBootstrap.url).origin;
        expect(result.output).toContain(
          `download TLS failed (ECONNRESET) from ${origin}; retrying download attempt 3`,
        );
        expect(result.output).toContain(
          `Cloud worker node bootstrap download TLS failed (ECONNRESET) from ${origin}:`,
        );
        expect(result.output).toContain(
          `The worker could not reach the Gateway public origin <${origin}>; verify the provider's network can reach it (for example with curl from a sandbox) or configure gateway.publicOrigin on a reachable hostname.`,
        );
      }
      const authorization = `Bearer ${nodeBootstrap.token}`;
      expect(new Set(authorizations)).toEqual(
        failure === "tls-reset" ? new Set() : new Set([authorization]),
      );
      if (failure === "truncated") {
        expect(authorizations.length).toBeGreaterThanOrEqual(3);
      } else {
        expect(authorizations).toHaveLength(
          failure === "http-reset" ? 9 : failure === "tls-reset" ? 0 : 1,
        );
      }
      if (failure === "http-reset" || failure === "tls-reset" || failure === "truncated") {
        const terminalNoProgressFailure =
          /\(download attempt \d+; 9 consecutive no-progress failures\)/;
        const retryOnlyOutput = result.output
          .split("\n")
          .filter((line) => /\([0-8]\/9 consecutive no-progress failures\)/.test(line))
          .join("\n");
        expect(retryOnlyOutput).not.toBe("");
        expect(retryOnlyOutput).not.toMatch(terminalNoProgressFailure);
        expect(result.output).toMatch(terminalNoProgressFailure);
      }
      expectAbsent(path.join(stateDir, "node.pid"));
      expect(fs.readdirSync(stateDir)).toEqual([]);
      expect(fs.readdirSync(runtimeRoot(home))).toEqual([]);
    },
  );

  it("validates a pinned TLS certificate before transmitting artifact authority", async ({
    signal,
  }) => {
    const { home, stateDir } = testHome();
    const { nodeBootstrap, authorizations } = await servePackage("tls", { tls: true });
    const rejected = await enroll(home, { ...nodeBootstrap, tlsFingerprint: "f".repeat(64) });
    expectFailure(
      rejected,
      `download TLS failed from ${new URL(nodeBootstrap.url).origin}: Cloud worker bootstrap TLS fingerprint mismatch`,
    );
    expect(authorizations).toHaveLength(0);
    await expectSetupPhases(enroll(home, nodeBootstrap));
    expect((await readLaunch(stateDir, receipts, signal)).build).toBe("tls");
    expect(authorizations).toEqual([`Bearer ${nodeBootstrap.token}`]);
  }, 30_000);
});

// The remote owner is Linux Bash; macOS's bundled Bash 3 cannot execute mapfile.
const hasBashMapfile = spawnSync("bash", ["-c", "type mapfile"], { encoding: "utf8" }).status === 0;

describe.runIf(hasBashMapfile)("Crabbox desktop node bootstrap", () => {
  it.for([0, 19])(
    "finishes desktop setup after launch and on live replay (initial exit %s)",
    { timeout: 30_000 },
    async (exitCode, { signal }) => {
      const { home, stateDir } = testHome();
      const readiness = path.join(home, "desktop-ready");
      execFileSync("mkfifo", [readiness]);
      const readinessFd = fs.openSync(readiness, fs.constants.O_RDWR);
      cleanups.push(() => fs.closeSync(readinessFd));
      const { nodeBootstrap, authorizations } = await servePackage("desktop");
      const setup = `set -eu
[ -z "\${CRABBOX_WORKER_BOOTSTRAP_TOKEN-}" ]
[ -z "\${CRABBOX_WORKER_SETUP_CODE-}" ]
[ "$DISPLAY" = :99 ]
[ "$DBUS_SESSION_BUS_ADDRESS" = unix:path=/run/fixture/bus ]
if [ ! -f "$OPENCLAW_STATE_DIR/launch.json" ]; then
  IFS= read -r ready < "$HOME/desktop-ready"
  [ "$ready" = ready ]
fi
[ -f "$OPENCLAW_STATE_DIR/launch.json" ]
IFS= read -r pid < "$OPENCLAW_STATE_DIR/node.pid"
kill -0 "$pid"
echo "$pid" >> "$OPENCLAW_STATE_DIR/desktop-pids"
# ${"x".repeat(160_000)}
`;
      const desktop = { enabled: true, setup: `${setup}exit ${exitCode}\n` };
      const first = await enroll(home, nodeBootstrap, desktop, false, undefined, { signal });
      expect(first.code).toBe(exitCode === 0 ? 0 : 1);
      expect(first.output.includes("CRABBOX_PHASE:openclaw-bootstrap-complete")).toBe(
        exitCode === 0,
      );
      if (exitCode !== 0) {
        expect(first.output).toContain("desktop setup failed with exit code 19");
      }
      const pid = readText(stateDir, "node.pid").trim();
      await expectSetupPhases(
        enroll(home, nodeBootstrap, { enabled: true, setup }, false, undefined, { signal }),
      );
      expect(readText(stateDir, "desktop-pids")).toBe(`${pid}\n${pid}\n`);
      expect(readText(stateDir, "node.pid").trim()).toBe(pid);
      expect(authorizations).toEqual([`Bearer ${nodeBootstrap.token}`]);
    },
  );

  it.for([
    { enabled: true, runtimeDir: "/run/fixture", pluginIds: ["demo"], verbose: false },
    { enabled: true, runtimeDir: "", pluginIds: ["demo"], verbose: false },
    { enabled: false, runtimeDir: "/run/fixture", pluginIds: ["demo"], verbose: false },
    { enabled: false, runtimeDir: "/run/fixture", pluginIds: [], verbose: false },
    {
      enabled: true,
      runtimeDir: "/run/fixture",
      pluginIds: ["demo", "cua-computer"],
      verbose: true,
    },
  ])(
    "binds only desktop nodes to the exact XFCE session: %j",
    { timeout: 30_000 },
    async ({ enabled, runtimeDir, pluginIds, verbose }, { signal }) => {
      const { home, stateDir } = testHome();
      const served = await servePackage(verbose ? "verbose-activation" : "desktop");
      const nodeBootstrap = { ...served.nodeBootstrap, enabledPluginIds: pluginIds };
      await expectSetupPhases(enroll(home, nodeBootstrap, { enabled, runtimeDir }));
      const launch = await readLaunch(stateDir, receipts, signal);
      expect(launch.enabledPlugins).toEqual(enabled ? ["demo", "cua-computer"] : pluginIds);
      const activationFile = path.join(stateDir, "activation.jsonl");
      const activations = fs.existsSync(activationFile)
        ? fs
            .readFileSync(activationFile, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
        : [];
      expect(activations).toEqual(
        enabled || pluginIds.length > 0 ? [{ runtimePublished: false }] : [],
      );
      expect(launch.environment).toEqual(
        enabled ? desktopEnvironment(runtimeDir) : loginEnvironment,
      );
      expectPrivate(launch);
    },
  );

  it.each([{ display: ":0" }, { dbus: "" }, { runtimeDir: "relative-directory" }])(
    "refuses an invalid XFCE binding before artifact download or node launch: %j",
    async (invalid) => {
      const { home, stateDir } = testHome();
      const { nodeBootstrap, authorizations } = await servePackage("invalid-desktop");
      const result = await enroll(home, nodeBootstrap, { enabled: true, ...invalid });
      expectFailure(result, "XFCE session");
      expect(authorizations).toEqual([]);
      expect(fs.existsSync(path.join(stateDir, "node.pid"))).toBe(false);
    },
  );
});

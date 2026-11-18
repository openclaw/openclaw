import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import {
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { commandResult } from "../../test-support/command-result.test-support.js";
import * as processRunner from "./crabbox-process.js";
import { createCrabboxNodeEnrollmentSetup } from "./crabbox-worker-node-enrollment.js";
import {
  createNodeBootstrapFixture,
  createNodePackageFixture,
  createNodeResumeFixture,
  expectPrivate,
  expectResumePublicationFailures,
  readLaunch,
  runtimeManifestSha256,
} from "./crabbox-worker-node-enrollment.test-support.js";
import { createCrabboxNodeResumer } from "./crabbox-worker-node-resume.js";

let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(() => receipts.close());
const cleanups: Array<() => Promise<void>> = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanupDirectories) =>
  afterEach(async () => {
    try {
      for (const cleanup of cleanups.splice(0).toReversed()) {
        await cleanup();
      }
    } finally {
      vi.restoreAllMocks();
      cleanupDirectories();
    }
  }),
);
const leaseId = "cbx_resume_fixture";
const readText = (...parts: string[]) => fs.readFileSync(path.join(...parts), "utf8");

async function createResumeTest(version: string, signal: AbortSignal, desktop = false) {
  const home = fs.realpathSync(tempDirs.make("crabbox-resume-"));
  const stateDir = path.join(home, ".openclaw/cloud-workers", leaseId);
  const runtimeRoot = path.join(home, ".openclaw-worker/node-runtimes");
  const packageRoot = (digest: string) => path.join(runtimeRoot, digest, "node_modules/openclaw");
  const pidFile = path.join(stateDir, "node.pid");
  const stop = async () => {
    if (!fs.existsSync(pidFile)) {
      return;
    }
    const pid = Number(readText(pidFile));
    try {
      process.kill(-pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        throw error;
      }
    }
    await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow("ESRCH"));
  };
  const desktopEnv = {
    DISPLAY: ":99",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/fixture/bus",
    XDG_RUNTIME_DIR: "/run/fixture",
  };
  if (desktop) {
    fs.mkdirSync(path.join(home, "proc/123"), { recursive: true });
    fs.writeFileSync(path.join(home, "desktop.env"), "CRABBOX_DESKTOP_ENV=xfce\nDISPLAY=:99\n");
    fs.writeFileSync(
      path.join(home, "proc/123/environ"),
      Object.entries(desktopEnv)
        .map(([key, value]) => key + "=" + value)
        .join("\0") + "\0",
    );
    fs.writeFileSync(path.join(home, "pgrep"), "#!/bin/sh\necho 123\n", { mode: 0o700 });
  }
  const guest = async (source: string, env: NodeJS.ProcessEnv = {}, profile?: string) => {
    const child = spawn("/bin/sh", [], {
      env: {
        HOME: home,
        PATH: process.env.PATH,
        ...(desktop
          ? {
              DISPLAY: ":0",
              DBUS_SESSION_BUS_ADDRESS: "wrong-login-bus",
              XDG_RUNTIME_DIR: "/run/wrong",
            }
          : {}),
        ...env,
      },
      signal,
      stdio: "pipe",
    });
    const output: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.push(chunk));
    const script = source
      .replaceAll("/var/lib/crabbox/desktop.env", path.join(home, "desktop.env"))
      .replaceAll("/proc/$process_pid/environ", home + "/proc/$process_pid/environ")
      .replaceAll("pgrep -u", path.join(home, "pgrep") + " -u");
    child.stdin.end((profile ? `set -a; . ${JSON.stringify(profile)}; set +a\n` : "") + script);
    const [code] = await once(child, "close");
    return commandResult({ code, stdout: Buffer.concat(output).toString("utf8") });
  };
  const makeArchive = (archiveVersion: string, postinstall = "") =>
    createNodePackageFixture(
      (prefix) => tempDirs.make(prefix),
      "same-node-resume",
      receipts,
      postinstall,
      "bundle",
      archiveVersion,
    );
  const oldArchive = await makeArchive("2026.8.1");
  const currentArchive = await makeArchive(version, "// updated build");
  const workerArchive = Buffer.from("current worker archive");
  const artifacts = new Map([
    ["/old", oldArchive],
    ["/current", currentArchive],
    ["/worker", workerArchive],
  ]);
  const downloads: string[] = [];
  const server = http.createServer((request, response) => {
    const archive = artifacts.get(request.url!);
    if (!archive || request.headers.authorization !== "Bearer synthetic-bootstrap-token") {
      response.writeHead(403).end();
      return;
    }
    downloads.push(request.url!);
    response.writeHead(200, { "content-length": archive.length });
    response.end(archive);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });
  cleanups.push(stop);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected local artifact server");
  }
  const bootstrap = async (route: string, archive: Buffer, openclawVersion: string) =>
    createNodeBootstrapFixture({
      url: `http://127.0.0.1:${address.port}${route}`,
      sha256: createHash("sha256").update(archive).digest("hex"),
      bytes: archive.length,
      install: "bundle",
      buildId: "fixture-runtime-build",
      manifestSha256: await runtimeManifestSha256(archive),
      openclawVersion,
    });
  const old = await bootstrap("/old", oldArchive, "2026.8.1");
  const nodeBootstrap = await bootstrap("/current", currentArchive, version);
  const workerHash = createHash("sha256").update(workerArchive).digest("hex");
  const runtime = {
    nodeBootstrap,
    workerBundle: {
      url: `http://127.0.0.1:${address.port}/worker`,
      token: nodeBootstrap.token,
      sha256: workerHash,
      bytes: workerArchive.length,
      packageRelativePath: `worker-artifacts/${workerHash}.tgz`,
    },
  };
  const setup = createCrabboxNodeEnrollmentSetup({
    leaseId,
    desktop,
    enrollment: {
      mode: "connect",
      setupCode: "synthetic-enrollment-credential",
      setupId: "resume-test",
      openclawVersion: old.openclawVersion,
      nodeBootstrap: old,
      displayName: "Resume test",
      waitForDeviceId: async () => "device-test",
    },
  });
  // Platform trust is outside this proof; never update the test host's certificate store.
  const initial = await guest(
    setup.command.replaceAll(
      "/usr/sbin/update-ca-certificates",
      path.join(home, "absent-system-trust-fixture"),
    ),
    setup.forwardedEnv,
  );
  expect(initial.code, initial.stdout).toBe(0);
  await readLaunch(stateDir, receipts, signal);
  return {
    home,
    stateDir,
    runtimeRoot,
    packageRoot,
    pidFile,
    stop,
    guest,
    old,
    nodeBootstrap,
    runtime,
    downloads,
  };
}

// Real installer, identity probes, process receipts and shipped IPC launcher; only
// Crabbox's external transport and Gateway artifact bytes are local fixtures.
describe.skipIf(process.platform !== "linux")("same-node runtime refresh", () => {
  it.for([
    { version: "2026.8.1", desktop: false },
    { version: "2026.8.2", desktop: false },
    { version: "2026.8.1", desktop: true },
    { version: "2026.8.2", desktop: true },
  ])(
    "installs fresh resume grants without changing enrollment or workspace: %j",
    async ({ version, desktop }, { signal }) => {
      const {
        stateDir,
        runtimeRoot,
        packageRoot,
        pidFile,
        stop,
        guest,
        old,
        nodeBootstrap,
        runtime,
        downloads,
      } = await createResumeTest(version, signal, desktop);
      const initialPid = readText(pidFile);
      const activation = readText(stateDir, "activation.jsonl");
      const savedSetup = readText(stateDir, "setup-code");
      const sentinel = path.join(stateDir, "workspace-sentinel");
      fs.writeFileSync(sentinel, "uncommitted workspace stays here");
      vi.spyOn(processRunner, "runCrabboxProcess").mockImplementation(async (argv, options) => {
        expect(argv[1]).toBe("run");
        expect(argv).toContain("--no-hydrate");
        expect(argv).toContain("--no-sync");
        expect(String(options.input)).not.toContain(nodeBootstrap.token);
        const profileIndex = argv.indexOf("--env-from-profile");
        return guest(
          String(options.input),
          options.env,
          profileIndex < 0 ? undefined : argv[profileIndex + 1],
        );
      });
      const resume = createCrabboxNodeResumer({
        signal,
        resolveBinary: async () => ({ binary: "crabbox-fixture" }),
      });
      const request = {
        leaseId,
        profile: { provider: "aws", ttl: "24h", idleTimeout: "60m", desktop },
        deviceId: "device-test",
        platform: "linux",
        signal,
        nodeBootstrapSha256: nodeBootstrap.sha256,
        openclawVersion: version,
        runtime,
        assertCurrent() {},
      };
      await resume(request);
      const launch = await readLaunch(stateDir, receipts, signal);
      expect(readText(pidFile)).not.toBe(initialPid);
      expect(launch.cli).toBe(path.join(packageRoot(nodeBootstrap.sha256), "openclaw.mjs"));
      expect(launch.args.slice(0, 4)).toEqual(["node", "run", "--resume-device", "device-test"]);
      expectPrivate(launch);
      if (desktop) {
        expect(launch.environment).toEqual({
          DISPLAY: ":99",
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/fixture/bus",
          XDG_RUNTIME_DIR: "/run/fixture",
        });
      }
      expect(readText(stateDir, "saved-device")).toBe("device-test");
      expect(readText(stateDir, "setup-code")).toBe(savedSetup);
      expect(readText(sentinel)).toBe("uncommitted workspace stays here");
      expect(readText(stateDir, "activation.jsonl")).toBe(activation);
      expect(fs.existsSync(packageRoot(old.sha256))).toBe(true);
      expect(
        readText(packageRoot(nodeBootstrap.sha256), runtime.workerBundle.packageRelativePath),
      ).toBe("current worker archive");
      expect(downloads.toSorted()).toEqual(["/current", "/old", "/worker"]);
      const upgradedPid = readText(pidFile);
      await resume(request);
      expect(readText(pidFile)).toBe(upgradedPid);
      const retainedRequest = {
        ...request,
        retainedRuntimeOnly: true as const,
        nodeBootstrapSha256: "0".repeat(64),
        openclawVersion: "future-version",
        runtime: { ...runtime, nodeBootstrap: { ...nodeBootstrap, sha256: "0".repeat(64) } },
      };
      await resume(retainedRequest);
      expect(readText(pidFile)).toBe(upgradedPid);
      expect(downloads).toHaveLength(3);
      await stop();
      // Shipped selectors may retain the creation-time digest as an alias.
      const digestPath = path.join(runtimeRoot, nodeBootstrap.sha256);
      const canonical = path.join(runtimeRoot, "retained-runtime");
      fs.renameSync(digestPath, canonical);
      fs.symlinkSync(canonical, digestPath);
      await resume({
        ...request,
        runtime: undefined,
        nodeBootstrapSha256: old.sha256,
        openclawVersion: old.openclawVersion,
      });
      expect(await readLaunch(stateDir, receipts, signal)).toMatchObject({
        cli: path.join(canonical, "node_modules/openclaw/openclaw.mjs"),
      });
      const aliasedPid = readText(pidFile);
      await resume(request);
      expect(readText(pidFile)).toBe(aliasedPid);
      expect(downloads).toHaveLength(3);
      await stop();
      await resume(retainedRequest);
      const retainedLaunch = await readLaunch(stateDir, receipts, signal);
      if (desktop) {
        expect(retainedLaunch.environment).toEqual({
          DISPLAY: ":99",
          DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/fixture/bus",
          XDG_RUNTIME_DIR: "/run/fixture",
        });
      }
      expect(fs.realpathSync(path.join(stateDir, "runtime"))).toBe(canonical);
      expect(readText(sentinel)).toBe("uncommitted workspace stays here");
      expect(downloads).toHaveLength(3);
    },
  );
  it("recovers only the saved process and preserves custody across interrupted launch publication", async ({
    signal,
  }) => {
    const { home, stateDir, packageRoot, pidFile, stop, old, downloads } = await createResumeTest(
      "2026.8.1",
      signal,
    );
    const { invoke, resume } = createNodeResumeFixture({
      home,
      leaseId,
      nodeBootstrap: old,
      signal,
    });
    const initialPid = readText(pidFile);
    const activation = readText(stateDir, "activation.jsonl");
    const installed = readText(packageRoot(old.sha256), "node-runtime.manifest.json");
    fs.writeFileSync(path.join(stateDir, "workspace-sentinel"), "private work stays here");
    expect(resume().status).toBe(0);
    expect(readText(pidFile)).toBe(initialPid);
    await stop();
    await expectResumePublicationFailures({
      home,
      stateDir,
      initialPid,
      receipts,
      signal,
      resume: (env) => resume({}, env),
      invoke,
    });
    expect(resume().status).toBe(0);
    const launch = await readLaunch(stateDir, receipts, signal);
    expect(readText(pidFile)).not.toBe(initialPid);
    expect(launch.args).toEqual([
      "node",
      "run",
      "--resume-device",
      "device-test",
      "--ephemeral",
      "--display-name",
      "Cloud worker",
    ]);
    expectPrivate(launch);
    expect(readText(stateDir, "workspace-sentinel")).toBe("private work stays here");
    expect(readText(stateDir, "activation.jsonl")).toBe(activation);
    expect(readText(packageRoot(old.sha256), "node-runtime.manifest.json")).toBe(installed);
    expect(downloads).toEqual(["/old"]);
    expect(resume({ deviceId: "other-device" }).status).toBe(1);
    // Preparation hints can be older than the saved runtime after a completed upgrade.
    expect(
      resume({ nodeBootstrapSha256: "0".repeat(64), openclawVersion: "older-version" }).status,
    ).toBe(0);
    await stop();
    const deadPid = readText(pidFile);
    try {
      fs.writeFileSync(pidFile, String(process.pid));
      expect(resume().stderr).toContain("different bootstrap artifact or invocation");
    } finally {
      fs.writeFileSync(pidFile, deadPid);
    }
    fs.unlinkSync(pidFile);
    expect(resume().stderr).toContain("launch is incomplete");
    expect(fs.existsSync(pidFile)).toBe(false);
  });
});

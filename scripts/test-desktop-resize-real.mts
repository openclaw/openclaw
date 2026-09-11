import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, rm, statfs, writeFile } from "node:fs/promises";
import net from "node:net";
import { userInfo } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getFreePort } from "../src/test-utils/ports.ts";
import { assertPrebuiltUiE2eRuntime } from "../test/vitest/vitest.ui-e2e-prebuilt.global-setup.ts";
import {
  desktopProofCommit,
  desktopProofSource,
  desktopProofSshdFailure,
  exportDesktopResizeProof,
  inspectDesktopSshdRuntimeDirectory,
  readDesktopProofPhase,
  readDesktopProofTestReport,
  withDesktopProofCleanup,
} from "./lib/desktop-resize-proof.mts";
import { hasUnjoinedWork, runManagedCommand } from "./lib/managed-child-process.mts";

const root = process.cwd();
const output = path.join(root, ".artifacts/control-ui-e2e/real-gateway/desktop-resize");
const packages = [
  "tigervnc-standalone-server",
  "tigervnc-tools",
  "xauth",
  "openbox",
  "xterm",
  "xdotool",
  "x11-xserver-utils",
  "x11-utils",
  "procps",
  "fonts-dejavu-core",
];
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const lifetime = new AbortController();
const receipt = {
  complete: false,
  phase: "preflight",
  failureCode: null as string | null,
  startedAt: new Date().toISOString(),
  provisioning:
    "Upstream Ubuntu packages and synthetic worker records; not Crabbox installer or cloud provisioning proof",
  source: null as ReturnType<typeof desktopProofSource> | null,
  workflowSha: process.env.DESKTOP_PROOF_WORKFLOW_SHA ?? null,
  runId: process.env.GITHUB_RUN_ID ?? null,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  nodeVersion: process.version,
  architecture: process.arch,
  initialFreeBytes: 0,
  prebuiltGeneration: "",
  preinstalledSsh: {
    serverVersion: "",
    serverBinarySha256: "",
    runtimeDirectory: null as Awaited<ReturnType<typeof inspectDesktopSshdRuntimeDirectory>> | null,
    configFailure: null as ReturnType<typeof desktopProofSshdFailure> | null,
  },
  provenance: {
    kind: "upstream-os" as const,
    osRelease: "",
    packageOrigin:
      "Observed runner APT metadata and dpkg versions; archive origin not independently qualified",
    packages: [] as Array<{ name: string; version: string; sha256: string }>,
    serverBinarySha256: "",
  },
  commands: [] as Array<{ label: string; exitCode: number | null; elapsedMs: number }>,
  carriers: [] as string[],
  testDiagnostics: [] as Array<{
    carrier: "node" | "ssh";
    status: "pending" | "available" | "missing" | "invalid";
    report: Awaited<ReturnType<typeof readDesktopProofTestReport>> | null;
    checkpoint: Awaited<ReturnType<typeof readDesktopProofPhase>>;
  }>,
  cleanup: {
    joined: false,
    unjoinedWork: false,
    testOwnersClosed: true,
    listenersClosed: false,
    privateFixtureRemoved: false,
  },
};
let privateRoot: string;
let sshd:
  | { pid: number; config: string; stop: (before?: () => Promise<void>) => Promise<void> }
  | undefined;
const daemons: Array<() => Promise<void>> = [];
const ports: number[] = [];
const artifactBudget = { entries: 0, bytes: 0 };
const saveReceipt = () =>
  writeFile(path.join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);

function recordFailure(error: unknown) {
  // Record at the child owner, before another error can mask failed process-tree cleanup.
  receipt.cleanup.unjoinedWork ||= hasUnjoinedWork(error);
  if (receipt.cleanup.unjoinedWork) {
    receipt.cleanup.joined = false;
  }
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  const known = ["ENOSPC", "ENOENT", "EACCES", "ETIMEDOUT", "ABORT_ERR", "ERR_ASSERTION"];
  receipt.failureCode = receipt.cleanup.unjoinedWork
    ? "EPROCESSGROUP_CLEANUP_FAILED"
    : (receipt.failureCode ??
      (typeof code === "string" && known.includes(code) ? code : "FIXTURE_OR_EVIDENCE_FAILURE"));
}

async function requireSpace(minimumGiB: number) {
  const disk = await statfs(root);
  const available = disk.bavail * disk.bsize;
  assert(available >= minimumGiB * 1024 ** 3, `Desktop proof requires ${minimumGiB} GiB free`);
  return available;
}

async function run(
  label: string,
  bin: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; input?: string; timeoutMs?: number; cleanup?: boolean } = {},
) {
  if (!options.cleanup) {
    lifetime.signal.throwIfAborted();
  }
  receipt.phase = label;
  console.log(`[desktop-resize-proof] ${label}`);
  const cap = new AbortController();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const log: Buffer[] = [];
  let bytes = 0;
  let exitCode: number | null = null;
  const started = Date.now();
  return withDesktopProofCleanup(
    async () => {
      exitCode = await runManagedCommand({
        bin,
        args,
        cwd: root,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_NO_LAZY_FETCH: "1",
          GIT_NO_REPLACE_OBJECTS: "1",
          ...options.env,
        },
        stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        timeoutMs: options.timeoutMs ?? 30_000,
        signal: options.cleanup ? cap.signal : AbortSignal.any([lifetime.signal, cap.signal]),
        requireProcessTreeExit: true,
        onReady(child) {
          const append = (data: Buffer, target?: Buffer[]) => {
            bytes += data.length;
            if (bytes > 8 * 1024 ** 2) {
              cap.abort();
            } else {
              log.push(data);
              target?.push(data);
            }
          };
          child.stdout!.on("data", (data: Buffer) => append(data, stdout));
          child.stderr!.on("data", (data: Buffer) => append(data, stderr));
          child.stdin?.end(options.input);
        },
      });
      assert.equal(exitCode, 0, `${label} failed`);
      return Buffer.concat(stdout);
    },
    async () => {
      receipt.commands.push({ label, exitCode, elapsedMs: Date.now() - started });
      await withDesktopProofCleanup(
        async () => {
          if (label === "sshd-config" && exitCode !== 0) {
            receipt.preinstalledSsh.configFailure = desktopProofSshdFailure(
              Buffer.concat(stderr).toString(),
            );
          }
        },
        async () => {
          if (privateRoot) {
            await writeFile(path.join(privateRoot, `${label}.log`), Buffer.concat(log), {
              mode: 0o600,
            });
          }
          await saveReceipt();
        },
        recordFailure,
      );
    },
    recordFailure,
  );
}

function daemon(label: string, bin: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const stop = new AbortController();
  let stopping = false;
  let bytes = 0;
  const log: Buffer[] = [];
  const completion = withDesktopProofCleanup(
    () =>
      runManagedCommand({
        bin,
        args,
        cwd: root,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
        signal: stop.signal,
        requireProcessTreeExit: true,
        onReady(child) {
          const append = (data: Buffer) => {
            bytes += data.length;
            if (bytes > 4 * 1024 ** 2) {
              lifetime.abort();
            } else {
              log.push(data);
            }
          };
          child.stdout!.on("data", append);
          child.stderr!.on("data", append);
        },
      }).then(
        () => {
          if (!stopping) {
            throw new Error(`${label} exited early`);
          }
        },
        (error: unknown) => {
          if (
            !stopping ||
            !(error instanceof Error) ||
            !("code" in error) ||
            error.code !== "ABORT_ERR"
          ) {
            throw error;
          }
        },
      ),
    () => writeFile(path.join(privateRoot, `${label}.log`), Buffer.concat(log), { mode: 0o600 }),
    recordFailure,
  );
  void completion.catch(() => lifetime.abort());
  return async (before?: () => Promise<void>) => {
    stopping = true;
    await withDesktopProofCleanup(
      async () => {
        await before?.();
      },
      async () => {
        stop.abort();
        await completion;
      },
      recordFailure,
    );
  };
}

async function tcpReady(port: number) {
  return new Promise<boolean>((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const finish = (ready: boolean) => {
      socket.destroy();
      resolve(ready);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

async function waitFor(test: () => Promise<boolean>, cleanup = false) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (!cleanup) {
      lifetime.signal.throwIfAborted();
    }
    if (await test()) {
      return;
    }
    await sleep(100);
  }
  throw new Error("Desktop fixture readiness deadline exceeded");
}

async function sourceIdentity() {
  const head = (await run("source-head", "git", ["rev-parse", "--verify", "HEAD"]))
    .toString()
    .trim();
  const commit = await run("source-identity", "git", ["cat-file", "commit", head]);
  const source = desktopProofSource(desktopProofCommit(head, commit.toString()), {
    checkout: process.env.DESKTOP_PROOF_CHECKOUT_SHA ?? "",
    head: process.env.DESKTOP_PROOF_PR_HEAD_SHA,
    base: process.env.DESKTOP_PROOF_PR_BASE_SHA,
  });
  assert.equal(
    (await run("source-clean", "git", ["status", "--porcelain", "--untracked-files=all"]))
      .toString()
      .trim(),
    "",
  );
  if (receipt.source) {
    assert.deepEqual(source, receipt.source);
  }
  return source;
}

async function main() {
  await mkdir(path.dirname(output), { recursive: true });
  await mkdir(output);
  await saveReceipt();
  const interrupt = () => lifetime.abort();
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) {
    process.once(signal, interrupt);
  }
  const deadline = setTimeout(interrupt, 12 * 60_000);
  const watchdog = setInterval(() => void requireSpace(5).catch(interrupt), 10_000);
  let failure: unknown;
  try {
    assert.equal(process.platform, "linux");
    assert(process.env.RUNNER_TEMP, "RUNNER_TEMP is required");
    assert.notEqual(process.getuid!(), 0, "Run the proof as the CI job user");
    assert.match(receipt.workflowSha ?? "", /^[a-f0-9]{40}$/u);
    assert.match(receipt.runId ?? "", /^\d+$/u);
    assert.match(receipt.runAttempt ?? "", /^\d+$/u);
    receipt.initialFreeBytes = await requireSpace(15);
    privateRoot = await mkdtemp(path.join(process.env.RUNNER_TEMP, "desktop-resize-"));
    await chmod(privateRoot, 0o700);
    receipt.source = await sourceIdentity();
    receipt.prebuiltGeneration = assertPrebuiltUiE2eRuntime(root);
    const osRelease = await readFile("/etc/os-release", "utf8");
    assert.match(osRelease, /^ID=ubuntu$/mu);
    receipt.provenance.osRelease = /^PRETTY_NAME="([^"]+)"$/mu.exec(osRelease)![1]!;
    await access("/usr/sbin/sshd");
    await access("/usr/bin/ssh");
    receipt.preinstalledSsh.serverVersion = (
      await run("sshd-package", "dpkg-query", ["-W", "-f=${Version}", "openssh-server"])
    )
      .toString()
      .trim();
    receipt.preinstalledSsh.serverBinarySha256 = sha256(await readFile("/usr/sbin/sshd"));
    await run("apt-update", "sudo", ["-n", "apt-get", "update"], { timeoutMs: 180_000 });
    await run(
      "apt-install",
      "sudo",
      [
        "-n",
        "env",
        "DEBIAN_FRONTEND=noninteractive",
        "apt-get",
        "install",
        "-y",
        "--no-install-recommends",
        ...packages,
      ],
      { timeoutMs: 300_000 },
    );
    for (const name of packages) {
      const version = (await run(`version-${name}`, "dpkg-query", ["-W", "-f=${Version}", name]))
        .toString()
        .trim();
      const metadata = (
        await run(`archive-${name}`, "apt-cache", ["show", `${name}=${version}`])
      ).toString();
      const hash = /^SHA256: ([a-f0-9]{64})$/mu.exec(metadata)?.[1];
      assert(hash, `Missing APT metadata hash for ${name}`);
      receipt.provenance.packages.push({ name, version, sha256: hash });
    }
    receipt.provenance.serverBinarySha256 = sha256(await readFile("/usr/bin/Xtigervnc"));
    const authority = path.join(privateRoot, "Xauthority");
    const passwordFile = path.join(privateRoot, "vnc-password");
    const encodedPassword = path.join(privateRoot, "vnc-password-encoded");
    const password = randomBytes(6).toString("hex").slice(0, 8);
    await writeFile(passwordFile, password, { mode: 0o600 });
    await writeFile(
      encodedPassword,
      await run("vnc-password", "tigervncpasswd", ["-f"], { input: `${password}\n` }),
      { mode: 0o600 },
    );
    await writeFile(authority, "", { mode: 0o600 });
    for (const display of [99, 100]) {
      for (const file of [`/tmp/.X${display}-lock`, `/tmp/.X11-unix/X${display}`]) {
        await assert.rejects(access(file), { code: "ENOENT" });
      }
      const port = 5900 + display;
      assert.equal(await tcpReady(port), false, "Desktop fixture port is already occupied");
      ports.push(port);
      await run(`xauth-${display}`, "xauth", [
        "-f",
        authority,
        "add",
        `:${display}`,
        ".",
        randomBytes(16).toString("hex"),
      ]);
      daemons.push(
        daemon(`vnc-${display}`, "Xtigervnc", [
          `:${display}`,
          "-auth",
          authority,
          "-rfbport",
          String(port),
          "-geometry",
          "1920x1080",
          "-depth",
          "24",
          "-localhost",
          "yes",
          "-SecurityTypes",
          "VncAuth",
          "-PasswordFile",
          encodedPassword,
          "-AlwaysShared",
          "-AcceptSetDesktopSize",
          display === 99 ? "1" : "0",
          "-nolisten",
          "tcp",
          "-desktop",
          "OpenClaw resize proof",
        ]),
      );
      await waitFor(() => tcpReady(port));
      const home = path.join(privateRoot, `desktop-${display}`);
      await mkdir(home, { mode: 0o700 });
      const env = {
        DISPLAY: `:${display}`,
        XAUTHORITY: authority,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_CACHE_HOME: path.join(home, ".cache"),
        XDG_RUNTIME_DIR: home,
      };
      // Plain Openbox has no session autostart; authentication agents would escape
      // process-group ownership. The fixture needs only a foreground WM and xterm.
      daemons.push(daemon(`wm-${display}`, "openbox", ["--sm-disable"], env));
      await waitFor(async () =>
        /0x[1-9a-f][a-f0-9]*/iu.test(
          (
            await run(`wm-${display}`, "xprop", ["-root", "_NET_SUPPORTING_WM_CHECK"], { env })
          ).toString(),
        ),
      );
      daemons.push(
        daemon(
          `terminal-${display}`,
          "xterm",
          [
            "-title",
            "OpenClaw resize proof",
            "-geometry",
            "100x30+0+0",
            "-fa",
            "DejaVu Sans Mono",
            "-fs",
            "14",
            "-e",
            "bash",
            "--noprofile",
            "--norc",
          ],
          { ...env, PS1: "proof$ ", HISTFILE: "/dev/null" },
        ),
      );
    }
    const identity = path.join(privateRoot, "identity");
    const hostKey = path.join(privateRoot, "host-key");
    for (const file of [identity, hostKey]) {
      await run(`key-${path.basename(file)}`, "ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        "desktop-resize-proof",
        "-f",
        file,
      ]);
    }
    const publicKey = async (file: string) =>
      (await readFile(`${file}.pub`, "utf8")).trim().split(/\s+/u).slice(0, 2).join(" ");
    const authorized = path.join(privateRoot, "authorized-keys");
    await writeFile(authorized, `${await publicKey(identity)}\n`, { mode: 0o600 });
    const sshPort = await getFreePort();
    ports.push(sshPort);
    const config = path.join(privateRoot, "sshd_config");
    const pidFile = path.join(privateRoot, "sshd.pid");
    const user = userInfo().username;
    await writeFile(
      config,
      [
        `Port ${sshPort}`,
        "ListenAddress 127.0.0.1",
        `HostKey ${hostKey}`,
        `PidFile ${pidFile}`,
        `AuthorizedKeysFile ${authorized}`,
        `AllowUsers ${user}`,
        "AuthenticationMethods publickey",
        "PubkeyAuthentication yes",
        "PasswordAuthentication no",
        "KbdInteractiveAuthentication no",
        "PermitEmptyPasswords no",
        "PermitRootLogin no",
        "UsePAM yes",
        "StrictModes no",
        "AllowTcpForwarding local",
        "GatewayPorts no",
        "X11Forwarding no",
        "PermitTunnel no",
        "PrintMotd no",
        "LogLevel ERROR",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    // Ubuntu compiles this privsep path; direct sshd does not create the service runtime directory.
    receipt.preinstalledSsh.runtimeDirectory =
      await inspectDesktopSshdRuntimeDirectory("/run/sshd");
    await run("sshd-config", "sudo", ["-n", "/usr/sbin/sshd", "-t", "-f", config]);
    const stop = daemon("sshd", "sudo", ["-n", "/usr/sbin/sshd", "-D", "-e", "-f", config]);
    // Register teardown before readiness: a failed bootstrap still owns its child.
    sshd = { pid: 0, config, stop };
    await waitFor(() => tcpReady(sshPort));
    sshd.pid = Number((await readFile(pidFile, "utf8")).trim());
    assert(Number.isSafeInteger(sshd.pid) && sshd.pid > 1);
    const fixture = {
      ssh: {
        host: "127.0.0.1",
        port: sshPort,
        user,
        hostKey: await publicKey(hostKey),
        keyRef: { source: "env", provider: "default", id: "DESKTOP_PROOF_KEY" },
      },
      identityPath: identity,
      xauthorityPath: authority,
      desktop: { protocol: "rfb", port: 5999, passwordFilePath: passwordFile },
      fixedDesktop: { protocol: "rfb", port: 6000, passwordFilePath: passwordFile },
      provenance: receipt.provenance,
      controlUiRoot: path.join(root, "dist/control-ui"),
    };
    for (const carrier of ["node", "ssh"] as const) {
      const raw = path.join(privateRoot, carrier);
      await mkdir(raw);
      const fixtureFile = path.join(privateRoot, `${carrier}.json`);
      const reportFile = path.join(privateRoot, `${carrier}-vitest.json`);
      const diagnosticDirectory = path.join(privateRoot, `${carrier}-diagnostics`);
      await mkdir(diagnosticDirectory, { mode: 0o700 });
      const diagnostic: (typeof receipt.testDiagnostics)[number] = {
        carrier,
        status: "pending",
        report: null,
        checkpoint: {
          status: "unavailable",
          lastObservedPhase: null,
          owners: null,
        },
      };
      receipt.testDiagnostics.push(diagnostic);
      receipt.cleanup.testOwnersClosed = false;
      await writeFile(fixtureFile, JSON.stringify({ ...fixture, carrier }), { mode: 0o600 });
      await withDesktopProofCleanup(
        async () => {
          await run(
            `test-${carrier}`,
            process.execPath,
            [
              "scripts/run-vitest.mjs",
              "run",
              "--config",
              "test/vitest/vitest.ui-e2e-prebuilt.config.ts",
              "--configLoader",
              "runner",
              "--reporter=json",
              "--outputFile",
              reportFile,
              "--includeTaskLocation",
              "ui/src/e2e/desktop-resize.real-gateway.e2e.test.ts",
            ],
            {
              timeoutMs: 240_000,
              env: {
                OPENCLAW_DESKTOP_REAL_FIXTURE: fixtureFile,
                OPENCLAW_UI_E2E_ARTIFACT_DIR: raw,
                OPENCLAW_UI_E2E_DIAGNOSTIC_DIR: diagnosticDirectory,
              },
            },
          );
        },
        () =>
          withDesktopProofCleanup(
            async () => {
              // Terminal JSON may be absent after process termination; collect this independently.
              diagnostic.checkpoint = await readDesktopProofPhase(
                path.join(diagnosticDirectory, "desktop-phase.json"),
              );
              // The Gateway owns a detached group; joining Vitest alone cannot retire it.
              const owners = diagnostic.checkpoint.owners;
              const ownersClosed =
                owners !== null && owners.gateway !== "owned" && owners.endpointTap !== "owned";
              receipt.cleanup.testOwnersClosed = receipt.testDiagnostics.every(
                ({ checkpoint }) =>
                  checkpoint.owners !== null &&
                  checkpoint.owners.gateway !== "owned" &&
                  checkpoint.owners.endpointTap !== "owned",
              );
              try {
                diagnostic.report = await readDesktopProofTestReport(reportFile);
                diagnostic.status = "available";
              } catch (error) {
                diagnostic.status =
                  error instanceof Error && "code" in error && error.code === "ENOENT"
                    ? "missing"
                    : "invalid";
                throw error;
              }
              assert.equal(diagnostic.checkpoint.status, "available");
              assert(ownersClosed, "Desktop child resource cleanup is unverified");
              assert.deepEqual(owners, { gateway: "closed", endpointTap: "closed" });
            },
            async () => {
              const exported = await exportDesktopResizeProof(
                raw,
                path.join(output, carrier),
                carrier,
                artifactBudget,
              );
              if (exported.proof) {
                for (const [name, hash] of Object.entries(exported.proof.assets)) {
                  assert.equal(
                    sha256(await readFile(path.join(root, "dist/control-ui/assets", name))),
                    hash,
                  );
                }
              }
              assert(
                exported.complete,
                `Incomplete ${carrier} desktop proof (including a skipped test)`,
              );
            },
            recordFailure,
          ),
        recordFailure,
      );
      await sourceIdentity();
      assert.equal(assertPrebuiltUiE2eRuntime(root), receipt.prebuiltGeneration);
      receipt.carriers.push(carrier);
    }
  } catch (error) {
    recordFailure(error);
    failure = error;
  } finally {
    clearInterval(watchdog);
    clearTimeout(deadline);
    const failedPhase = failure ? receipt.phase : null;
    const cleanupErrors: unknown[] = [];
    if (sshd) {
      try {
        const owned = sshd;
        await owned.stop(async () => {
          if (!owned.pid) {
            owned.pid = Number((await readFile(path.join(privateRoot, "sshd.pid"), "utf8")).trim());
          }
          assert(Number.isSafeInteger(owned.pid) && owned.pid > 1);
          assert.equal(
            (
              await run("sshd-executable", "sudo", ["-n", "readlink", `/proc/${owned.pid}/exe`], {
                cleanup: true,
              })
            )
              .toString()
              .trim(),
            "/usr/sbin/sshd",
          );
          const command = (
            await run("sshd-owner", "sudo", ["-n", "cat", `/proc/${owned.pid}/cmdline`], {
              cleanup: true,
            })
          )
            .toString()
            .replaceAll("\0", " ");
          assert(command.includes(`-f ${owned.config}`), "Private sshd ownership changed");
          await run("stop-sshd", "sudo", ["-n", "/bin/kill", "-TERM", String(owned.pid)], {
            cleanup: true,
          });
        });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const stop of daemons.toReversed()) {
      try {
        await stop();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await waitFor(
        async () => (await Promise.all(ports.map(tcpReady))).every((ready) => !ready),
        true,
      );
      receipt.cleanup.listenersClosed = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
    for (const error of cleanupErrors) {
      recordFailure(error);
    }
    receipt.cleanup.joined =
      cleanupErrors.length === 0 &&
      !receipt.cleanup.unjoinedWork &&
      receipt.cleanup.testOwnersClosed;
    if (!failure && receipt.cleanup.joined) {
      try {
        await sourceIdentity();
        assert.equal(assertPrebuiltUiE2eRuntime(root), receipt.prebuiltGeneration);
        assert.deepEqual(receipt.carriers, ["node", "ssh"]);
        receipt.complete = true;
      } catch (error) {
        recordFailure(error);
        failure = error;
      }
    }
    if (!failure && receipt.cleanup.joined && privateRoot) {
      try {
        await rm(privateRoot, { recursive: true });
        receipt.cleanup.privateFixtureRemoved = true;
      } catch (error) {
        recordFailure(error);
        receipt.complete = false;
      }
    }
    receipt.phase = failedPhase ?? (receipt.complete ? "complete" : "cleanup");
    await saveReceipt();
    for (const signal of signals) {
      process.removeListener(signal, interrupt);
    }
  }
  if (!receipt.complete) {
    throw new Error(`Desktop proof incomplete at ${receipt.phase}`);
  }
}

await main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Desktop proof failed");
  console.error("[desktop-resize-proof] FAILED (exit 1)");
  process.exitCode = 1;
});

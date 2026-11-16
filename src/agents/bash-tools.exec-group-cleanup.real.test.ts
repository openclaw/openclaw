import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getSpawnBroker } from "../process/spawn-broker/context.js";
import { createProcessSupervisor } from "../process/supervisor/supervisor.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { withEnvAsync } from "../test-utils/env.js";
import { observeMainThreadFs } from "../test-utils/main-thread-fs-spies.test-support.js";
import {
  registerOneShotExecScopeCleanup,
  stopSessionExecProcesses,
} from "./bash-process-control.js";
import { getSession, listRunningSessions } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import { createProcessTool } from "./bash-tools.process.js";

const nativeIdentity = vi.hoisted(
  (): { observe?: () => void; reject?: (pid: number) => void } => ({}),
);
vi.mock("@openclaw/proc-safe/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/proc-safe/identity")>();
  return {
    ...actual,
    readProcessIdentity: (...args: Parameters<typeof actual.readProcessIdentity>) => {
      nativeIdentity.observe?.();
      nativeIdentity.reject?.(args[0]);
      return actual.readProcessIdentity(...args);
    },
  };
});

vi.mock("../process/supervisor/index.js", () => ({
  getProcessSupervisor: () => supervisor,
}));
const memoryOwner = vi.hoisted(() => ({ resetBudget: () => {} }));
vi.mock("../shared/global-singleton.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/global-singleton.js")>();
  return {
    ...actual,
    resolveGlobalSingleton: (...args: Parameters<typeof actual.resolveGlobalSingleton>) => {
      const owner = actual.resolveGlobalSingleton(...args);
      if (args[0] === Symbol.for("openclaw.hostExecMemory") && owner && typeof owner === "object") {
        memoryOwner.resetBudget = () => {
          Object.assign(owner, { budget: undefined });
        };
      }
      return owner;
    },
  };
});

let supervisor: ReturnType<typeof createProcessSupervisor>;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const started: number[] = [];
beforeEach(() => {
  supervisor = createProcessSupervisor();
});
afterEach(async () => {
  for (const pid of started.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
  await supervisor.shutdown();
  memoryOwner.resetBudget();
  resetProcessRegistryForTests();
  vi.restoreAllMocks();
});

/** Fail only fresh identity inspection after the real adopted birth has been captured. */
function observeIdentityFailure() {
  let unavailablePid: number | undefined;
  const failed = vi.fn(() => {
    throw Object.assign(new Error("synthetic identity read failure"), { code: "EIO" });
  });
  nativeIdentity.reject = (pid) => {
    if (pid === unavailablePid) {
      failed();
    }
  };
  const readFile = fs.readFile.bind(fs);
  const reads = vi
    .spyOn(fs, "readFile")
    .mockImplementation(async (...args: Parameters<typeof readFile>) => {
      if (unavailablePid !== undefined && args[0] === `/proc/${unavailablePid}/stat`) {
        failed();
      }
      return await readFile(...args);
    });
  return {
    failed,
    async fail(pid: number) {
      if (process.platform === "linux") {
        const capture =
          reads.mock.results[reads.mock.calls.findIndex(([file]) => file === `/proc/${pid}/stat`)];
        expect(capture?.type).toBe("return");
        await expect(capture?.value).resolves.toEqual(expect.any(String));
      }
      unavailablePid = pid;
    },
    recover() {
      unavailablePid = undefined;
    },
    [Symbol.dispose]() {
      delete nativeIdentity.reject;
      reads.mockRestore();
    },
  };
}

const MAX_SERVICES_PER_SESSION = 16;
const byNumber = (left: number | undefined, right: number | undefined) =>
  (left ?? 0) - (right ?? 0);
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const node = quote(process.execPath);
const sleeper = `${node} -e 'setTimeout(() => {}, 60000)'`;

async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return true;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  return check();
}

function testEnv(cwd: string, serviceMarker?: string) {
  return {
    OPENCLAW_SERVICE_MARKER: serviceMarker,
    OPENCLAW_STATE_DIR: path.join(cwd, "state"),
    OPENCLAW_HOME: cwd,
    OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
    SHELL: "/bin/sh",
  };
}

function firstPid(text: string): number {
  const pid = Number(/PID=(\d+)/.exec(text)?.[1]);
  expect(pid).toBeGreaterThan(1);
  started.push(pid);
  return pid;
}

function aggregated(details: { status: string; aggregated?: string }): string {
  return details.aggregated ?? "";
}

function hostExec(cwd: string, scopeKey: string, allowBackground = false) {
  return createExecTool({
    host: "gateway",
    mode: "full",
    ask: "off",
    allowBackground,
    notifyOnExit: false,
    scopeKey,
    cwd,
  });
}

function runningIn(scopeKey: string) {
  return listRunningSessions().filter((session) => session.scopeKey === scopeKey);
}

it.skipIf(process.platform === "win32")(
  "adopts what 20 completed commands leave running, past the cap, and leaves no relay or anchor",
  async () => {
    const cwd = tempDirs.make("exec-group-cleanup-");
    const scopeKey = "agent:main:exec-group-cleanup";
    const fixture = path.join(cwd, "command.cjs");
    await fs.writeFile(
      fixture,
      `const { spawn, execFileSync } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 300000)"], {
  stdio: ["ignore", "ignore", "ignore", 3],
});
child.unref();
child.once("spawn", () => {
  const grandparent = Number(execFileSync("ps", ["-o", "ppid=", "-p", String(process.ppid)], { encoding: "utf8" }).trim());
  process.stdout.write(JSON.stringify([child.pid, process.ppid, grandparent]) + "\\n");
});
`,
    );
    const helpers: number[] = [];
    const adopted: number[] = [];
    await withEnvAsync(testEnv(cwd, "exec-group-cleanup-test"), async () => {
      const exec = hostExec(cwd, scopeKey);
      await expect(exec.execute("invalid", { command: "printf bad\0command" })).rejects.toThrow(
        /NUL bytes|null bytes/,
      );
      const corrected = await exec.execute("corrected", {
        command: "printf '<%s>\\n' '' '\\0'\ncat <<'EOF'\nheredoc\\0\nEOF",
      });
      expect(corrected.details).toMatchObject({
        status: "completed",
        exitCode: 0,
        aggregated: "<>\n<\\0>\nheredoc\\0",
      });
      for (let call = 0; call < 20; call += 1) {
        const result = await exec.execute(`exec-${call}`, {
          command: `exec ${node} ${quote(fixture)}`,
        });
        expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
        const output = aggregated(result.details);
        const [survivor, ...group]: number[] = JSON.parse(output.split("\n")[0]!);
        expect(
          [survivor, ...group].every((pid) => Number.isSafeInteger(pid) && (pid ?? 0) > 1),
        ).toBe(true);
        started.push(survivor!);
        // Every survivor is reported and tracked; capacity never stops one.
        expect(output).toMatch(new RegExp(`pid ${survivor} .*keeps running as background session`));
        adopted.push(survivor!);
        // The direct native owner has a shared caller, not an owned relay above it.
        const hosts = new Set([process.pid, getSpawnBroker()?.pid]);
        helpers.push(...group.filter((pid) => !hosts.has(pid)));
      }
      // OpenClaw's own relay and anchor processes always exit (#150750).
      expect(await waitFor(() => helpers.every((pid) => !isPidAlive(pid)))).toBe(true);
      expect(adopted.filter((pid) => !isPidAlive(pid))).toEqual([]);
      // Adopted survivors are ordinary background sessions of this session.
      expect(
        runningIn(scopeKey)
          .map((session) => session.pid)
          .toSorted(byNumber),
      ).toEqual(adopted.toSorted(byNumber));
      const processTool = createProcessTool({ scopeKey });
      const listed = await processTool.execute("list", { action: "list" });
      expect(listed.details).toMatchObject({
        sessions: expect.arrayContaining(adopted.map((pid) => expect.objectContaining({ pid }))),
      });
      // process kill stops one by identity.
      const target = runningIn(scopeKey).find((session) => session.pid === adopted[0])!;
      await processTool.execute("kill", { action: "kill", sessionId: target.id });
      expect(await waitFor(() => !isPidAlive(adopted[0]!) && target.exited)).toBe(true);
      expect(target.exitReason).toBe("manual-cancel");
      // A process that exits on its own drops out within one reap interval.
      process.kill(adopted[1]!, "SIGKILL");
      expect(await waitFor(() => runningIn(scopeKey).length === adopted.length - 2, 7_000)).toBe(
        true,
      );
      // Gateway stop ends what is left.
      await supervisor.shutdown();
      expect(await waitFor(() => adopted.every((pid) => !isPidAlive(pid)))).toBe(true);
    });
  },
  120_000,
);

it.skipIf(process.platform === "win32")(
  "keeps shell-backgrounded, nohup and double-forked processes after a completed call but stops them on timeout",
  async () => {
    const cwd = tempDirs.make("exec-detached-styles-");
    const scopeKey = "agent:main:exec-detached-styles";
    const daemon = await writeDaemon(cwd);
    await withEnvAsync(testEnv(cwd, "exec-detached-styles-test"), async () => {
      const exec = hostExec(cwd, scopeKey);
      const survivors: number[] = [];
      for (const command of [
        `${sleeper} >/dev/null 2>&1 & echo PID=$!`,
        `nohup ${sleeper} >/dev/null 2>&1 & echo PID=$!`,
        `${sleeper} & echo PID=$!`,
        // The root prints what its descendant recorded; later descendant output is discarded.
        `${node} ${quote(daemon)} daemon.pid && cat daemon.pid`,
      ]) {
        const result = await exec.execute("style", { command, timeoutSeconds: 30 });
        expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
        survivors.push(firstPid(aggregated(result.details)));
      }
      await exec.execute("next", { command: "true" });
      expect(survivors.filter((pid) => !isPidAlive(pid))).toEqual([]);

      // Timeout is still foreground cleanup: everything the command started stops.
      const timedOut = await exec.execute("timeout", {
        command: `${sleeper} >/dev/null 2>&1 & echo PID=$!; exec ${sleeper}`,
        timeoutSeconds: 1,
      });
      expect(timedOut.details).toMatchObject({ status: "failed" });
      const killed = firstPid(aggregated(timedOut.details));
      expect(await waitFor(() => !isPidAlive(killed))).toBe(true);
      expect(survivors.filter((pid) => !isPidAlive(pid))).toEqual([]);
      // Session reset or delete stops what the session's commands left running.
      // macOS has no subreaper, so a daemon that left the group is not seen or tracked there.
      await stopSessionExecProcesses([scopeKey], () => {});
      const tracked = process.platform === "linux" ? survivors : survivors.slice(0, 3);
      expect(await waitFor(() => tracked.every((pid) => !isPidAlive(pid)))).toBe(true);
    });
  },
);

async function writeDaemon(cwd: string): Promise<string> {
  const daemon = path.join(cwd, "daemon.cjs");
  // Classic daemon: an intermediate starts a new session and exits, so the
  // service is re-parented away from the command (to the Linux subreaper or init).
  await fs.writeFile(
    daemon,
    `const { spawn } = require("node:child_process");
if (process.argv[2] === "middle") {
  const service = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });
  service.unref();
  require("node:fs").writeFileSync(process.argv[3], "PID=" + service.pid + "\\n");
  process.exit(0);
}
const middle = spawn(process.execPath, [__filename, "middle", process.argv[2]], { detached: true, stdio: "ignore" });
middle.on("exit", () => process.exit(0));
`,
  );
  return daemon;
}

it.skipIf(process.platform !== "linux")(
  "a timeout still stops setsid and double-forked children on Linux",
  async () => {
    const cwd = tempDirs.make("exec-timeout-escapees-");
    const daemon = await writeDaemon(cwd);
    await withEnvAsync(testEnv(cwd, "exec-timeout-escapees-test"), async () => {
      const exec = hostExec(cwd, "agent:main:exec-timeout-escapees");
      const result = await exec.execute("timeout", {
        command: `setsid ${sleeper} >/dev/null 2>&1 < /dev/null & echo PID=$!; ${node} ${quote(daemon)} daemon.pid && cat daemon.pid; exec ${sleeper}`,
        timeoutSeconds: 2,
      });
      expect(result.details).toMatchObject({ status: "failed" });
      const pids = [...aggregated(result.details).matchAll(/PID=(\d+)/g)].map((match) =>
        Number(match[1]),
      );
      expect(pids).toHaveLength(2);
      started.push(...pids);
      expect(await waitFor(() => pids.every((pid) => !isPidAlive(pid)))).toBe(true);
    });
  },
);

it.skipIf(process.platform === "win32")(
  "one-shot run cleanup hands off services, prints them, and stops in-flight commands",
  async () => {
    const cwd = tempDirs.make("exec-one-shot-");
    const scopeKey = "agent:main:exec-one-shot";
    const cleanups: Array<(reason: string) => Promise<void>> = [];
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await withEnvAsync(testEnv(cwd), async () => {
      using identity = observeIdentityFailure();
      registerOneShotExecScopeCleanup(
        { oneShotCliRun: true, registerRunCleanup: (cleanup) => cleanups.push(cleanup) },
        scopeKey,
      );
      const exec = hostExec(cwd, scopeKey, true);
      const outputPid = async (details: unknown) => {
        const { sessionId } = details as { sessionId: string };
        await waitFor(() => /PID=\d+/.test(getSession(sessionId)?.aggregated ?? ""));
        return firstPid(getSession(sessionId)?.aggregated ?? "");
      };
      const service = await exec.execute("service", {
        command: `echo PID=$$; exec ${sleeper}`,
        background: true,
      });
      // A deliberate service has no default timeout.
      expect(JSON.stringify(service.content)).not.toContain("Automatic stop");
      const leftRunning = await exec.execute("left-running", {
        command: `${sleeper} >/dev/null 2>&1 & echo PID=$!`,
      });
      const leftRunningPid = firstPid(aggregated(leftRunning.details));
      const inFlight = await exec.execute("in-flight", {
        command: `echo PID=$$; exec ${sleeper}`,
        yieldMs: 10,
      });
      expect(service.details).toMatchObject({ status: "running" });
      expect(inFlight.details).toMatchObject({ status: "running" });
      const servicePid = await outputPid(service.details);
      const inFlightPid = await outputPid(inFlight.details);
      expect(cleanups).toHaveLength(1);
      await identity.fail(leftRunningPid);
      await cleanups[0]!("run-end");
      identity.recover();
      expect(await waitFor(() => !isPidAlive(inFlightPid))).toBe(true);
      const printed = stderr.mock.calls.map(([chunk]) => String(chunk)).join("");
      expect(printed).toContain(`pid ${servicePid}`);
      expect(printed).toContain(`pid ${leftRunningPid}`);
      expect(printed).not.toContain(`pid ${inFlightPid}`);
      // The one-shot exit hands everything off: even the host stop leaves them running.
      await supervisor.shutdown();
      expect(isPidAlive(servicePid)).toBe(true);
      expect(isPidAlive(leftRunningPid)).toBe(true);
    });
  },
);

it.skipIf(process.platform === "win32")(
  "handed-off services that log per request still answer 20 requests 10 s after the run ends",
  async () => {
    const cwd = tempDirs.make("exec-one-shot-stdio-");
    const scopeKey = "agent:main:exec-one-shot-stdio";
    const server = path.join(cwd, "server.cjs");
    await fs.writeFile(
      server,
      `const http = require("node:http");
const s = http.createServer((req, res) => { console.log("request " + req.url); console.error("served " + req.url); res.end("ok"); });
s.listen(0, "127.0.0.1", () => {
  if (process.argv[2]) require("node:fs").writeFileSync(process.argv[2], "PORT=" + s.address().port + "\\n");
  console.log("PORT=" + s.address().port);
});
`,
    );
    const cleanups: Array<(reason: string) => Promise<void>> = [];
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await withEnvAsync(testEnv(cwd), async () => {
      registerOneShotExecScopeCleanup(
        { oneShotCliRun: true, registerRunCleanup: (cleanup) => cleanups.push(cleanup) },
        scopeKey,
      );
      const exec = hostExec(cwd, scopeKey, true);
      const service = await exec.execute("service", {
        command: `exec ${node} ${quote(server)}`,
        background: true,
      });
      const { sessionId } = service.details as { sessionId: string };
      await waitFor(() => /PORT=\d+/.test(getSession(sessionId)?.aggregated ?? ""));
      const servicePort = Number(/PORT=(\d+)/.exec(getSession(sessionId)!.aggregated)![1]);
      // Plain `&` keeps the command's own stdout and stderr pipes.
      const plain = await exec.execute("plain", {
        command: `${node} ${quote(server)} plain.port & while [ ! -s plain.port ]; do sleep 0.1; done; cat plain.port`,
      });
      const plainPort = Number(/PORT=(\d+)/.exec(aggregated(plain.details))![1]);
      started.push(...listRunningSessions().flatMap((session) => session.pid ?? []));
      await cleanups[0]!("run-end");
      await new Promise((resolve) => {
        setTimeout(resolve, 10_000);
      });
      for (const port of [servicePort, plainPort]) {
        for (let request = 0; request < 20; request += 1) {
          const response = await fetch(`http://127.0.0.1:${port}/${request}`);
          expect(response.status).toBe(200);
        }
      }
    });
  },
  60_000,
);

it.skipIf(process.platform === "win32")(
  "tracks every survivor of one command past the cap and refuses a new declared service",
  async () => {
    const cwd = tempDirs.make("exec-cap-");
    const scopeKey = "agent:main:exec-cap";
    let reap: (() => unknown) | undefined;
    let drivingReaper = false;
    const ownerReads: Promise<unknown>[] = [];
    let completedReads = 0;
    const readFile = fs.readFile.bind(fs);
    vi.spyOn(fs, "readFile").mockImplementation((...args: Parameters<typeof readFile>) => {
      const owned = (new Error().stack ?? "").includes("supervisor/released-processes");
      const pending = readFile(...args);
      if (owned) {
        ownerReads.push(pending);
        const complete = () => {
          completedReads++;
        };
        void pending.then(complete, complete);
      }
      return pending;
    });
    const drainReaper = async () => {
      await vi.waitFor(async () => {
        const reads = [...ownerReads];
        await Promise.allSettled(reads);
        await setImmediate();
        expect(ownerReads).toHaveLength(reads.length);
      });
    };
    const interval = globalThis.setInterval;
    vi.spyOn(globalThis, "setInterval").mockImplementation((callback, delay, ...args) => {
      if ((new Error().stack ?? "").includes("supervisor/released-processes")) {
        reap = () => callback(...args);
        return interval(() => {
          if (!drivingReaper) {
            return callback(...args);
          }
        }, delay);
      }
      return interval(callback, delay, ...args);
    });
    await withEnvAsync(testEnv(cwd, "exec-cap-test"), async () => {
      const exec = hostExec(cwd, scopeKey, true);
      const fill = await exec.execute("fill", {
        command: `for i in $(seq 20); do ${sleeper} >/dev/null 2>&1 & echo PID=$!; done`,
      });
      const output = aggregated(fill.details);
      const pids = [...output.matchAll(/PID=(\d+)/g)].map((match) => Number(match[1]));
      started.push(...pids);
      expect(pids).toHaveLength(20);
      const tracked = runningIn(scopeKey).map((session) => session.pid!);
      expect(tracked.toSorted(byNumber)).toEqual(pids.toSorted(byNumber));
      expect(reap).toBeTypeOf("function");
      // Twelve real owner callbacks represent one minute at the five-second interval.
      // Pause only this timer's automatic delivery; the OS and process identities stay real.
      drivingReaper = true;
      reap!();
      await drainReaper();
      let syncCalls = 0;
      let nativeIdentityCalls = 0;
      nativeIdentity.observe = () => {
        if ((new Error().stack ?? "").includes("supervisor/released-processes")) {
          nativeIdentityCalls++;
        }
      };
      try {
        using filesystem = observeMainThreadFs();
        for (let tick = 0; tick < 12; tick++) {
          const nativeBefore = nativeIdentityCalls;
          const asyncBefore = completedReads;
          reap!();
          await drainReaper();
          const linux = process.platform === "linux" || process.platform === "android";
          expect(
            nativeIdentityCalls - nativeBefore === tracked.length * (linux ? 1 : 2) ||
              completedReads - asyncBefore === tracked.length * 2,
          ).toBe(true);
        }
        syncCalls = filesystem
          .stacks()
          .filter(({ stack }) => stack.includes("supervisor/released-processes"))
          .reduce((total, { calls }) => total + calls, 0);
      } finally {
        delete nativeIdentity.observe;
        drivingReaper = false;
      }
      expect({
        syncCalls,
        nativeIdentityCalls:
          process.platform === "linux" || process.platform === "android" ? nativeIdentityCalls : 0,
      }).toEqual({ syncCalls: 0, nativeIdentityCalls: 0 });
      expect(output).not.toMatch(/Stopped/);
      for (const pid of pids) {
        expect(output).toContain(`pid ${pid}`);
      }
      await expect(
        exec.execute("over-cap", { command: sleeper, background: true }),
      ).rejects.toThrow(/process list.*process kill/s);
      const extra = await exec.execute("extra", {
        command: `${sleeper} >/dev/null 2>&1 & echo PID=$!`,
      });
      const extraPid = firstPid(aggregated(extra.details));
      expect(aggregated(extra.details)).toMatch(
        new RegExp(`pid ${extraPid} .*keeps running as background session`),
      );
      expect(isPidAlive(extraPid)).toBe(true);
      expect(tracked.filter((pid) => !isPidAlive(pid))).toEqual([]);
      // Ordinary foreground work still runs.
      const result = await exec.execute("foreground", { command: "echo ok" });
      expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
    });
  },
  60_000,
);

it.skipIf(process.platform === "win32")(
  "reserves capacity across concurrent background starts",
  async () => {
    const cwd = tempDirs.make("exec-reserve-");
    const scopeKey = "agent:main:exec-reserve";
    await withEnvAsync(testEnv(cwd, "exec-reserve-test"), async () => {
      const exec = hostExec(cwd, scopeKey, true);
      const fill = await exec.execute("fill", {
        command: `for i in $(seq ${MAX_SERVICES_PER_SESSION - 1}); do ${sleeper} >/dev/null 2>&1 & echo PID=$!; done`,
      });
      started.push(
        ...[...aggregated(fill.details).matchAll(/PID=(\d+)/g)].map((m) => Number(m[1])),
      );
      expect(runningIn(scopeKey)).toHaveLength(MAX_SERVICES_PER_SESSION - 1);
      const starts = await Promise.allSettled(
        ["a", "b"].map((id) =>
          exec.execute(`start-${id}`, {
            command: `echo PID=$$; exec ${sleeper}`,
            background: true,
          }),
        ),
      );
      expect(starts.filter((start) => start.status === "fulfilled")).toHaveLength(1);
      expect(starts.filter((start) => start.status === "rejected")).toHaveLength(1);
      started.push(...runningIn(scopeKey).flatMap((session) => session.pid ?? []));
      expect(runningIn(scopeKey)).toHaveLength(MAX_SERVICES_PER_SESSION);
    });
  },
  60_000,
);

it.skipIf(process.platform === "win32")(
  "never stops helpers a command leaves for capacity, and tracks a loop that keeps running",
  async () => {
    const cwd = tempDirs.make("exec-helpers-");
    const scopeKey = "agent:main:exec-helpers";
    await withEnvAsync(testEnv(cwd, "exec-helpers-test"), async () => {
      const exec = hostExec(cwd, scopeKey);
      for (let call = 0; call < 3; call += 1) {
        const result = await exec.execute(`helpers-${call}`, {
          command: "for i in $(seq 17); do sleep 0.5 & done; echo ok",
        });
        expect(result.details).toMatchObject({ status: "completed", exitCode: 0 });
        expect(aggregated(result.details)).not.toMatch(/Stopped|could not confirm/i);
      }
      // Helpers end on their own and their sessions drop out within one reap interval.
      expect(await waitFor(() => runningIn(scopeKey).length === 0, 8_000)).toBe(true);
      const loop = await exec.execute("loop", {
        command: "while :; do sleep 0.05; done >/dev/null 2>&1 & echo PID=$!",
      });
      const loopPid = firstPid(aggregated(loop.details));
      expect(runningIn(scopeKey).map((session) => session.pid)).toContain(loopPid);
    });
  },
  60_000,
);

it.skipIf(process.platform === "win32")(
  "tracks a survivor's descendants in a new session, so stopping the session ends both",
  async () => {
    const cwd = tempDirs.make("exec-closure-");
    const scopeKey = "agent:main:exec-closure";
    const parent = path.join(cwd, "parent.cjs");
    // A shell-backgrounded parent starts a child in a new session and waits for it.
    await fs.writeFile(
      parent,
      `const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: true, stdio: "ignore" });
require("node:fs").writeFileSync(process.argv[2], "PID=" + process.pid + " PID=" + child.pid + "\\n");
setTimeout(() => {}, 60000);
`,
    );
    await withEnvAsync(testEnv(cwd, "exec-closure-test"), async () => {
      const exec = hostExec(cwd, scopeKey);
      const result = await exec.execute("closure", {
        command: `${node} ${quote(parent)} pids >/dev/null 2>&1 & while [ ! -s pids ]; do sleep 0.1; done; cat pids`,
      });
      const pids = [...aggregated(result.details).matchAll(/PID=(\d+)/g)].map((m) => Number(m[1]));
      started.push(...pids);
      expect(pids).toHaveLength(2);
      expect(
        runningIn(scopeKey)
          .map((session) => session.pid)
          .toSorted(byNumber),
      ).toEqual(pids.toSorted(byNumber));
      await stopSessionExecProcesses([scopeKey], () => {});
      expect(await waitFor(() => pids.every((pid) => !isPidAlive(pid)))).toBe(true);
    });
  },
);

it.skipIf(process.platform !== "linux")(
  "tracks the child of a setsid shell the subreaper adopted",
  async () => {
    const cwd = tempDirs.make("exec-setsid-closure-");
    const scopeKey = "agent:main:exec-setsid-closure";
    await withEnvAsync(testEnv(cwd, "exec-setsid-closure-test"), async () => {
      const exec = hostExec(cwd, scopeKey);
      const result = await exec.execute("setsid", {
        command: `setsid sh -c '${sleeper.replaceAll("'", "'\\''")} & echo PID=$! > child.pid; wait' >/dev/null 2>&1 < /dev/null & while [ ! -s child.pid ]; do sleep 0.1; done; cat child.pid`,
      });
      const childPid = firstPid(aggregated(result.details));
      expect(runningIn(scopeKey).map((session) => session.pid)).toContain(childPid);
      await stopSessionExecProcesses([scopeKey], () => {});
      expect(await waitFor(() => !isPidAlive(childPid))).toBe(true);
      expect(runningIn(scopeKey)).toEqual([]);
    });
  },
);

it.skipIf(process.platform === "win32").each(["signal-denied", "identity-unavailable"])(
  "keeps an adopted process tracked and reports uncertainty when its stop is not confirmed (%s)",
  async (failure) => {
    const cwd = tempDirs.make("exec-unconfirmed-");
    const scopeKey = "agent:main:exec-unconfirmed";
    await withEnvAsync(testEnv(cwd, "exec-unconfirmed-test"), async () => {
      const exec = hostExec(cwd, scopeKey);
      using identity = observeIdentityFailure();
      const result = await exec.execute("survivor", {
        command: `${sleeper} >/dev/null 2>&1 & echo PID=$!`,
      });
      const pid = firstPid(aggregated(result.details));
      const session = runningIn(scopeKey).find((candidate) => candidate.pid === pid)!;
      expect(session).toBeDefined();
      const processTool = createProcessTool({ scopeKey });
      if (failure === "identity-unavailable") {
        await identity.fail(pid);
        // Let the actual periodic reaper inspect the unavailable identity before Stop.
        await vi.waitFor(() => expect(identity.failed).toHaveBeenCalled(), { timeout: 6_000 });
        await setImmediate();
        expect(
          (await processTool.execute("observe", { action: "poll", sessionId: session.id })).details,
        ).toMatchObject({ status: "running" });
      }
      const realKill = process.kill.bind(process);
      // Signals to this process are denied, as for a process that changed user.
      const denied = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
        if (failure === "signal-denied" && target === pid && signal !== 0 && signal !== undefined) {
          throw Object.assign(new Error("denied"), { code: "EPERM" });
        }
        return realKill(target, signal);
      });
      await expect(stopSessionExecProcesses([scopeKey], () => {})).rejects.toThrow(
        /cleanup is still draining/,
      );
      expect(isPidAlive(pid)).toBe(true);
      expect(session.exited).toBe(false);
      expect(session.cleanupUncertain).toBe(true);
      expect(
        (await processTool.execute("confirm", { action: "poll", sessionId: session.id })).details,
      ).toMatchObject({ status: "running" });
      expect(session.aggregated).toContain(`could not confirm that pid ${pid} stopped`);
      expect(runningIn(scopeKey).map((candidate) => candidate.pid)).toContain(pid);
      if (failure === "identity-unavailable") {
        expect(
          denied.mock.calls.filter(([target, signal]) => target === pid && signal !== 0),
        ).toEqual([]);
      }
      // Once inspection and signals work again, retry stops it and settles the record.
      identity.recover();
      denied.mockRestore();
      await stopSessionExecProcesses([scopeKey], () => {});
      expect(await waitFor(() => !isPidAlive(pid) && session.exited)).toBe(true);
    });
  },
  30_000,
);

it.skipIf(process.platform !== "linux")(
  "completes host exec above the former per-command quarter while shared capacity is unused",
  async () => {
    vi.spyOn(os, "totalmem").mockReturnValue(1024 ** 3);
    vi.spyOn(process, "constrainedMemory").mockReturnValue(1024 ** 3);
    vi.spyOn(process.memoryUsage, "rss").mockReturnValue(0);
    const cwd = tempDirs.make("exec-shared-memory-");
    const fixture = path.join(cwd, "command.cjs");
    await fs.writeFile(
      fixture,
      `const allocation = Buffer.alloc(320 * 1024 ** 2, 1);
setTimeout(() => process.stdout.write(allocation[0] === 1 ? "memory-fit" : "corrupt"), 1500);
`,
    );
    await withEnvAsync(testEnv(cwd), async () => {
      const exec = createExecTool({
        host: "gateway",
        mode: "full",
        ask: "off",
        allowBackground: false,
        notifyOnExit: false,
        cwd,
      });
      const result = await exec.execute("memory", {
        command: `exec ${node} ${quote(fixture)}`,
        timeoutSeconds: 10,
      });
      expect(result.details).toMatchObject({
        status: "completed",
        exitCode: 0,
        aggregated: "memory-fit",
      });
    });
  },
);

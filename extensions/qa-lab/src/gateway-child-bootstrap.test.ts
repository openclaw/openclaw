import { spawnSync } from "node:child_process";
import fsSync, { existsSync, readFileSync, writeSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { clearTimeout as clearRealTimeout, setTimeout as realTimeout } from "node:timers";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runQaGatewayCliCommand } from "./gateway-child-command.js";
import { QaGatewayChildLifecycle } from "./gateway-child-lifecycle.js";
import { createQaGatewayChild } from "./gateway-child.js";
import { inspectLinuxProcessGroup, isQaPosixProcessGroupAlive } from "./posix-process-group.js";
import { runQaCli } from "./qa-cli-process.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

// Intercept the named ESM export consumed by the bootstrap owners; the default
// fs object remains native so unrelated fixture writes still reach the filesystem.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeSync: vi.fn(actual.writeSync) };
});

// RPC is outside these process-lifetime tests. HTTP readiness and all processes stay real.
vi.mock("./gateway-rpc-client.js", () => ({
  startQaGatewayRpcClient: async () => ({ request: async () => ({}), stop: async () => {} }),
}));

type FixtureRecord = {
  kind: string;
  pid: number;
  pgid: number;
  descendant?: number;
  tempRoot?: string;
  submittedKey?: string;
  runtime?: "bun" | "node";
  execPath?: string;
  buildPrivateQa?: string | null;
  enablePrivateQaCli?: string | null;
  nodeOptions?: string | null;
  gatewayOnlyEnvKeys?: string[];
  profile?: string | null;
};

// The fixture never contacts a provider or stores auth. Its independent failsafes
// and the parent watchdog also bound cleanup when the production owner is broken.
const fixtureSource = String.raw`
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
const [record, phase, mode, command, ...args] = process.argv.slice(2);
const pgid = Number(execFileSync("/bin/ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }).trim());
const write = (kind, extra = {}) => fs.appendFileSync(record,
  JSON.stringify({ kind, pid: process.pid, pgid, ...extra }) + "\n");
if (command === "descendant") {
  process.on("SIGTERM", () => {});
  setTimeout(() => process.exit(20), 30_000);
  write("descendant");
  process.send("ready");
} else {
  let input = "";
  if (command === "models") for await (const chunk of process.stdin) input += chunk;
  const current = command === "models" ? args[args.indexOf("--provider") + 1]
    : command === "update" ? (args.includes("--help") ? "help" : "repair") : command;
  write(current, {
    profile: process.env.OPENCLAW_PROFILE ?? null,
    buildPrivateQa: process.env.OPENCLAW_BUILD_PRIVATE_QA ?? null,
    enablePrivateQaCli: process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI ?? null,
    nodeOptions: process.env.NODE_OPTIONS ?? null,
    gatewayOnlyEnvKeys: Object.keys(process.env)
      .filter((key) => ["OPENCLAW_BUILD_PRIVATE_QA", "OPENCLAW_ENABLE_PRIVATE_QA_CLI", "NODE_OPTIONS"].includes(key.toUpperCase()))
      .sort(),
  });
  if (current === phase) {
    process.on("SIGTERM", () => {
      if (mode === "running") for (const [fd, label] of [[1, "stdout"], [2, "stderr"]]) {
        try { fs.writeSync(fd, "\nshutdown " + label + " diagnostic apiKey=synthetic-drain-secret\n"); }
        catch { /* The fault matrix can close either parent-side pipe. */ }
      }
    });
    setTimeout(() => process.exit(20), 30_000);
    const child = spawn(process.execPath, [process.argv[1], record, phase, mode, "descendant"],
      { stdio: ["ignore", mode === "closed-pipes" ? "ignore" : "inherit", mode === "closed-pipes" ? "ignore" : "inherit", "ipc"] });
    await once(child, "message");
    write("ready", { descendant: child.pid, tempRoot: process.env.OPENCLAW_QA_TEMP_ROOT,
      ...(mode === "failure" ? { submittedKey: input.trim() } : {}) });
    if (mode === "running") {
      fs.writeSync(2, "plugin registry still pending apiKey=synthetic-stderr-secret\n::error::stderr diagnostic\nstderr ready\n");
      fs.writeSync(1, "diagnostic ".repeat(400) + "\nplugin scan still pending Authorization: Bearer synthetic-stdout-secret\n##[error]stdout diagnostic\nstdout ready\n");
    }
    if (mode === "progress") {
      let phaseIndex = 0;
      process.on("SIGUSR1", () => {
        const phases = ["preflight", "doctor", "plugins", "completionCache"];
        const step = "finalize:" + phases[Math.min(phaseIndex++, phases.length - 1)];
        fs.writeSync(2, '[update finalize] ' + JSON.stringify({step, status: "in_progress"}) + "\n");
        write("progress");
      });
      process.on("SIGUSR2", () => { process.stdout.write("repair-complete"); process.exit(0); });
    }
    if (mode !== "running" && mode !== "progress") {
      if (mode === "failure") fs.writeSync(2, "Authorization: Bearer " + input.trim() + "\ncontext retained\n" + "diagnostic ".repeat(400));
      process.stdout.write("fixture-output");
      process.exit(mode === "failure" ? 17 : 0);
    }
  } else if (current === "gateway") {
    fs.writeFileSync(path.join(process.env.OPENCLAW_STATE_DIR, "candidate-owner"), String(process.pid));
    http.createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(request.url === "/readyz" ? { ready: true, agentDatabases: [] } : { ok: true }));
})
      .listen(Number(args[args.indexOf("--port") + 1]), "127.0.0.1");
  } else if (current === "message") {
    const ownerPid = Number(fs.readFileSync(path.join(process.env.OPENCLAW_STATE_DIR, "candidate-owner"), "utf8"));
    process.kill(ownerPid, 0);
    if (args.includes("--gateway-only")) throw new Error("Gateway-only argument reached scenario CLI");
    if (args.includes("--unsupported")) {
      console.error("candidate does not support this action");
      process.exit(2);
    }
    console.log(JSON.stringify({ ownerPid, args, cwd: process.cwd(), marker: process.env.QA_CLI_MARKER }));
  } else {
    if (current === "help") process.stdout.write("--accept-capabilities");
    process.exit(0);
  }
}
`;

async function bounded<T>(promise: Promise<T>, ms = 5_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = realTimeout(() => reject(new Error("bootstrap operation did not settle")), ms);
      }),
    ]);
  } finally {
    clearRealTimeout(timer);
  }
}

const dirs = createTempDirHarness();
const cleanups: Array<() => Promise<void>> = [];
const realKill = process.kill.bind(process);
const stoppedResult = { process: "confirmed-stopped", errors: [] };
const startOptions = {
  providerMode: "mock-openai",
  controlUiEnabled: false,
  transportBaseUrl: "http://127.0.0.1:1",
} as const;

function ownLifetime() {
  const lifetime = new QaGatewayChildLifecycle();
  cleanups.push(async () => {
    await lifetime.stop();
  });
  return lifetime;
}

function expectRuntimeEnv(records: FixtureRecord[], count: number, nodeOptions: string | null) {
  expect(records).toHaveLength(count);
  for (const record of records) {
    expect(record).toMatchObject({
      buildPrivateQa: nodeOptions === null ? null : "1",
      enablePrivateQaCli: nodeOptions === null ? null : "1",
      nodeOptions,
      ...(nodeOptions === null ? { gatewayOnlyEnvKeys: [] } : {}),
    });
  }
}
async function signalAndRead(
  child: Parameters<QaGatewayChildLifecycle["register"]>[0],
  signal: "SIGUSR1",
) {
  await bounded(
    new Promise<void>((resolve) => {
      child.stderr!.once("data", () => resolve());
      child.kill(signal);
    }),
  );
}
beforeEach(() => {
  vi.stubEnv("OPENCLAW_QA_LIVE_ANTHROPIC_SETUP_TOKEN", undefined);
  vi.stubEnv("OPENCLAW_LIVE_SETUP_TOKEN_VALUE", undefined);
  vi.stubEnv("OPENCLAW_QA_KEEP_TEMP", undefined);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(writeSync).mockReset();
  try {
    const results = await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
    for (const result of results) {
      if (result.status === "rejected") {
        throw result.reason;
      }
    }
    await dirs.cleanup();
  } finally {
    vi.unstubAllEnvs();
  }
});

function captureBootstrapBoundaries(failSink = false) {
  const messages: Array<{ command: string; event: string; [key: string]: unknown }> = [];
  const write = fsSync.writeSync;
  vi.mocked(writeSync).mockImplementation((...args) => {
    const line = args[1];
    if (args[0] === 2 && typeof line === "string" && line.startsWith("[qa-bootstrap] ")) {
      messages.push(JSON.parse(line.slice("[qa-bootstrap] ".length)));
      if (failSink) {
        throw new Error("diagnostic sink unavailable");
      }
      return Buffer.byteLength(line);
    }
    return Reflect.apply(write, fsSync, args);
  });
  return messages;
}

async function fixture(phase: string, mode: string) {
  const root = await dirs.makeTempDir("qa-bootstrap-lifetime-");
  const record = path.join(root, "events.jsonl");
  const cli = path.join(root, "fixture.mjs");
  await fs.writeFile(cli, fixtureSource);
  const records = (): FixtureRecord[] =>
    existsSync(record)
      ? readFileSync(record, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const pidAlive = (pid: number) => {
    // Inspect independently of the production group probe, excluding zombie orphans.
    const state = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" });
    if (state.error) {
      throw state.error;
    }
    return state.status === 0 && !state.stdout.trim().startsWith("Z");
  };
  const assertStopped = () => {
    for (const entry of records()) {
      expect(pidAlive(entry.pid), `fixture PID ${entry.pid}`).toBe(false);
      if (entry.pid === entry.pgid) {
        const groupAlive = isQaPosixProcessGroupAlive(entry.pgid);
        expect(
          groupAlive,
          groupAlive
            ? `fixture PGID ${entry.pgid} failure inspection: ${JSON.stringify(inspectLinuxProcessGroup(entry.pgid))}`
            : undefined,
        ).toBe(false);
      }
    }
  };
  const killFixtures = () => {
    for (const pid of new Set(records().map((entry) => entry.pid))) {
      if (!Number.isSafeInteger(pid) || pid <= 1) {
        throw new Error("invalid fixture PID");
      }
      try {
        realKill(pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw error;
        }
      }
    }
  };
  const owner = createQaGatewayChild();
  const pending: Promise<unknown>[] = [];
  const track = <T>(promise: Promise<T>) => {
    const observed = promise.catch((error: unknown) => error);
    pending.push(observed);
    return observed;
  };
  const watchdog = realTimeout(killFixtures, 20_000);
  cleanups.push(async () => {
    try {
      // Close admission first, then independently kill children even if stop hangs.
      const stopping = owner.stop();
      killFixtures();
      await bounded(Promise.all([...pending, stopping]));
      await vi.waitFor(assertStopped, { timeout: 5_000 });
    } finally {
      clearRealTimeout(watchdog);
    }
  });
  const command = {
    executablePath: process.execPath,
    argsPrefix: [cli, record, phase, mode],
    tempParentDir: root,
    usePackagedPlugins: true,
  };
  return {
    root,
    records,
    assertStopped,
    owner,
    track,
    command,
    runCli: (
      lifetime: QaGatewayChildLifecycle,
      args: string[],
      options: Partial<Parameters<typeof runQaGatewayCliCommand>[0]> = {},
    ) =>
      track(
        runQaGatewayCliCommand({
          ...command,
          lifetime,
          args,
          cwd: root,
          env: { HOME: root },
          ...options,
        }),
      ),
    start: () =>
      owner.start({
        ...startOptions,
        repoRoot: process.cwd(),
        command,
      }),
    ready: async (count = 1) => {
      await vi.waitFor(
        () => expect(records().filter((entry) => entry.kind === "ready")).toHaveLength(count),
        { timeout: 10_000 },
      );
      const ready = records().filter((entry) => entry.kind === "ready");
      for (const entry of ready) {
        expect(entry.pgid).toBe(entry.pid);
        expect(records().find((item) => item.pid === entry.descendant)?.pgid).toBe(entry.pgid);
      }
      return ready;
    },
  };
}

async function progressingRepair(bootstrapPhase?: "repair") {
  const f = await fixture("repair", "progress");
  const lifetime = ownLifetime();
  const registration = vi.spyOn(lifetime, "register");
  // Registration happens synchronously during runCli; inspect its child after starting.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const command = f.runCli(lifetime, ["update", "repair"], { bootstrapPhase });
  await f.ready();
  return { f, command, child: registration.mock.calls[0]![0] };
}

describe.skipIf(process.platform === "win32")("packaged QA bootstrap lifetime", () => {
  it("uses the direct candidate CLI while its Gateway owns the state", async () => {
    const messages = captureBootstrapBoundaries();
    vi.stubEnv("OPENCLAW_PROFILE", "operator-parent");
    const f = await fixture("hang", "running");
    const repoRoot = path.join(f.root, "harness");
    await fs.mkdir(path.join(repoRoot, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(repoRoot, "dist", "index.js"),
      'throw new Error("harness CLI must not touch candidate-owned state");\n',
    );
    const gateway = await f.owner.start({
      ...startOptions,
      repoRoot,
      command: { ...f.command, cwd: f.root, argsSuffix: ["--gateway-only"] },
      runtimeEnvPatch: {
        OPENCLAW_PROFILE: "operator-patch",
        NODE_OPTIONS: "--no-warnings",
        Node_Options: "--trace-warnings",
        OpenClaw_Build_Private_QA: "foreign",
        OpenClaw_Enable_Private_QA_Cli: "foreign",
        QA_CLI_MARKER: "gateway",
      },
    });
    const env = {
      gateway,
      repoRoot,
      providerMode: "mock-openai" as const,
      primaryModel: "openai/gpt-5",
      alternateModel: "openai/gpt-5",
    };
    await expect(
      runQaCli(env, ["message", "edit", "--json"], {
        json: true,
        env: { QA_CLI_MARKER: "scenario" },
      }),
    ).resolves.toEqual({
      ownerPid: gateway.pid,
      args: ["edit", "--json"],
      cwd: f.root,
      marker: "scenario",
    });
    await expect(runQaCli(env, ["message", "edit", "--unsupported"])).rejects.toThrow(
      "qa cli failed (2): candidate does not support this action",
    );
    expect(JSON.stringify(messages)).not.toMatch(
      /operator-parent|operator-patch|sk-qa-mock|fixture\.mjs/u,
    );
    const profiles = new Set(f.records().map((entry) => entry.profile));
    expect(profiles.size).toBe(1);
    const [profile] = profiles;
    expect(profile).toMatch(/^[a-z0-9][a-z0-9_-]{0,63}$/u);
    expect(profile).not.toBe("operator-parent");
    expect(profile).not.toBe("operator-patch");
    const records = f.records();
    expectRuntimeEnv(
      records.filter((entry) => ["openai", "anthropic", "help", "repair"].includes(entry.kind)),
      4,
      null,
    );
    expectRuntimeEnv(
      records.filter((entry) => entry.kind === "gateway" || entry.kind === "message"),
      3,
      "--no-warnings",
    );
    expect(isQaPosixProcessGroupAlive(gateway.pid!)).toBe(true);
  });

  it("preloads each direct Gateway launch, restart, and child CLI command", async () => {
    const f = await fixture("hang", "running");
    const preloadPath = path.join(f.root, "runtime-preload.mjs");
    await fs.writeFile(
      preloadPath,
      [
        'import fs from "node:fs";',
        `fs.appendFileSync(${JSON.stringify(path.join(f.root, "events.jsonl"))}, JSON.stringify({ kind: "preload", pid: process.pid, pgid: -1, runtime: process.versions.bun ? "bun" : "node", execPath: process.execPath }) + "\\n");`,
      ].join("\n"),
    );
    const gateway = await f.owner.start({
      ...startOptions,
      repoRoot: process.cwd(),
      command: f.command,
      runtimePreloads: [pathToFileURL(preloadPath).href],
    });

    await gateway.runCli(["message", "edit", "--json"]);
    await gateway.restartAfterStateMutation(async () => {});

    const records = f.records();
    const preloadedLaunches = records.filter((entry) => entry.kind === "preload");
    expect(preloadedLaunches).toHaveLength(3);
    expect(new Set(preloadedLaunches.map((entry) => entry.runtime))).toEqual(
      new Set([process.versions.bun ? "bun" : "node"]),
    );
    expect(new Set(preloadedLaunches.map((entry) => entry.execPath))).toEqual(
      new Set([process.execPath]),
    );
    for (const preload of preloadedLaunches) {
      const index = records.indexOf(preload);
      expect(records[index + 1]).toMatchObject({ pid: preload.pid });
    }
    expect(preloadedLaunches.map((entry) => records[records.indexOf(entry) + 1]?.kind)).toEqual([
      "gateway",
      "message",
      "gateway",
    ]);
  });

  it.each([
    { phase: "openai", mode: "running" },
    { phase: "anthropic", mode: "running" },
    { phase: "help", mode: "leader-exited" },
    { phase: "repair", mode: "leader-exited" },
  ])("stops during $phase ($mode) before any gateway spawn", async ({ phase, mode }) => {
    const f = await fixture(phase, mode);
    const starting = f.track(f.start());
    const [ready] = await f.ready();
    await expect(bounded(f.owner.stop())).resolves.toEqual(stoppedResult);
    expect(await bounded(starting)).toBeInstanceOf(Error);
    f.assertStopped();
    expect(f.records().some((entry) => entry.kind === "gateway")).toBe(false);
    expect(existsSync(ready!.tempRoot!)).toBe(false);
  });

  it("owns overlapping post-start commands without displacing the gateway", async () => {
    const f = await fixture("hang", "running");
    const gateway = await f.start();
    const pid = gateway.pid;
    const commands = [f.track(gateway.runCli(["hang"])), f.track(gateway.runCli(["hang"]))];
    await f.ready(2);
    expect(gateway.pid).toBe(pid);
    expect(isQaPosixProcessGroupAlive(pid!)).toBe(true);
    await expect(bounded(f.owner.stop())).resolves.toEqual(stoppedResult);
    for (const command of commands) {
      expect(await bounded(command)).toBeInstanceOf(Error);
    }
    f.assertStopped();
    expect(() => gateway.runCli(["hang"])).toThrow("lifecycle is closed");
  });

  it.each(["leader-exited", "closed-pipes"])(
    "settles descendants after successful CLI exit (%s)",
    async (mode) => {
      const messages = captureBootstrapBoundaries();
      const f = await fixture("probe", mode);
      const lifetime = ownLifetime();
      const drainObserved = createDeferred<void>();
      const releaseDrain = createDeferred<void>();
      const waitForClose = lifetime.waitForClose.bind(lifetime);
      vi.spyOn(lifetime, "waitForClose").mockImplementation(async (owned) => {
        await waitForClose(owned);
        drainObserved.resolve();
        await releaseDrain.promise;
      });
      const command = f.runCli(lifetime, ["probe"], { bootstrapPhase: "repair-help" });
      try {
        await f.ready();
        await bounded(drainObserved.promise);
        expect(messages.map(({ event }) => event)).toEqual(["start", "exit"]);
        expect(messages[1]).toMatchObject({ exitCode: 0, signalled: false });
        f.assertStopped();
      } finally {
        releaseDrain.resolve();
      }
      expect(await bounded(command)).toBe("fixture-output");
      expect(messages.map(({ event }) => event)).toEqual(["start", "exit", "settled"]);
      expect(messages[2]).toMatchObject({ processStopped: true, pipesClosed: true });
      expect(Number(messages[2]!.elapsedMs)).toBeGreaterThanOrEqual(Number(messages[1]!.elapsedMs));
      f.assertStopped();
      await expect(lifetime.stop()).resolves.toEqual(stoppedResult);
    },
  );

  it("allows progressing repair phases past the whole-command deadline and settles descendants", async () => {
    const messages = captureBootstrapBoundaries();
    const { f, command, child } = await progressingRepair("repair");
    let settled = false;
    const observed = command.then((value) => {
      settled = true;
      return value;
    });
    for (let phase = 1; phase <= 4; phase++) {
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(false);
      await signalAndRead(child, "SIGUSR1");
      await vi.waitFor(() =>
        expect(f.records().filter((entry) => entry.kind === "progress")).toHaveLength(phase),
      );
    }
    child.kill("SIGUSR2");
    expect(await bounded(observed)).toBe("repair-complete");
    expect(
      messages.filter(({ event }) => event === "repair-phase").map(({ phase }) => phase),
    ).toEqual(["preflight", "doctor", "plugins", "completionCache"]);
    f.assertStopped();
  });

  it("still times out a repair stalled after forward progress and settles its real tree", async () => {
    const { f, command, child } = await progressingRepair();
    await signalAndRead(child, "SIGUSR1");
    await vi.waitFor(() =>
      expect(f.records().filter((entry) => entry.kind === "progress")).toHaveLength(1),
    );
    await vi.advanceTimersByTimeAsync(120_000);
    const error = await bounded(command);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("no update repair phase progress for 120000ms");
    f.assertStopped();
  });

  it.each(["timeout", "cancel", "stdout", "stderr", "stdin", "process"] as const)(
    "retains bounded redacted diagnostics after %s failure and settles the real CLI tree",
    async (failure) => {
      const messages = captureBootstrapBoundaries(failure === "process");
      const f = await fixture("probe", "running");
      const lifetime = ownLifetime();
      const registration = vi.spyOn(lifetime, "register");
      if (failure === "timeout") {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      }
      const command = f.runCli(lifetime, ["probe", "unlabeled-argv-secret"], {
        bootstrapPhase: "mock-auth",
        env: { HOME: f.root, QA_SYNTHETIC_SECRET: "unlabeled-env-secret" },
        stdin: failure === "stdin" ? "unlabeled-stdin-secret" : undefined,
      });
      const child = registration.mock.calls[0]![0];
      const observed = { stdout: "", stderr: "" };
      for (const stream of ["stdout", "stderr"] as const) {
        child[stream]!.on("data", (chunk) => (observed[stream] += String(chunk)));
      }
      await f.ready();
      await vi.waitFor(() => {
        expect(observed.stdout).toContain("stdout ready");
        expect(observed.stderr).toContain("stderr ready");
      });
      let stopping: Promise<unknown> | undefined;
      if (failure === "timeout") {
        await vi.advanceTimersByTimeAsync(120_000);
      } else if (failure === "cancel") {
        stopping = f.track(lifetime.stop());
      } else {
        const error = Object.assign(
          new AggregateError(
            [new Error("unlabeled-nested-secret")],
            "apiKey=synthetic-stream-secret",
            { cause: new Error("unlabeled-cause-secret") },
          ),
          { spawnargs: ["unlabeled-spawnargs-secret"], env: { key: "unlabeled-error-env-secret" } },
        );
        if (failure === "process") {
          child.emit("error", error);
        } else if (failure === "stdin") {
          child.stdin!.emit("error", error);
        } else {
          await bounded(
            new Promise<void>((resolve) => {
              child[failure]!.once("error", () => resolve());
              child[failure]!.destroy(error);
            }),
          );
        }
      }
      (failure === "process" ? child.stderr! : child).emit("error", new Error("later failure"));
      const error = await bounded(command);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) {
        throw new Error("expected CLI failure");
      }
      expect(error.message).toContain(
        failure === "timeout"
          ? "exceeded 120000ms"
          : failure === "cancel"
            ? "CLI cancelled"
            : `${failure} failed`,
      );
      expect(error.message).not.toMatch(/later failure|diagnostic sink unavailable/u);
      expect(JSON.stringify(messages)).not.toMatch(/secret|apiKey|spawnargs|stdin|HOME/u);
      expect(messages.at(-1)).toMatchObject({
        event: "settled",
        processStopped: true,
        pipesClosed: true,
      });
      expect(error.message).toContain("plugin registry still pending apiKey=<redacted>");
      expect(error.message).toContain("plugin scan still pending Authorization: Bearer <redacted>");
      expect(error.message).toContain(": :error::stderr diagnostic");
      expect(error.message).toContain("# #[error]stdout diagnostic");
      expect(error.message.indexOf("plugin registry")).toBeLessThan(
        error.message.indexOf("plugin scan"),
      );
      for (const stream of ["stdout", "stderr"] as const) {
        if (failure !== stream) {
          expect(error.message).toContain(`shutdown ${stream} diagnostic apiKey=<redacted>`);
        }
      }
      expect(error.message.length).toBeLessThanOrEqual(2_048);
      expect(error.message).not.toMatch(/(^|[\r\n])[^\S\r\n]*::/u);
      expect(error).not.toHaveProperty("cause");
      expect(error).not.toHaveProperty("errors");
      const diagnostic = inspect(error, { depth: null });
      expect(diagnostic).not.toMatch(/synthetic-[\w-]+-secret|unlabeled-[\w-]+-secret/u);
      f.assertStopped();
      if (stopping) {
        expect(await bounded(stopping)).toEqual(stoppedResult);
      }
      await expect(lifetime.stop()).resolves.toEqual(stoppedResult);
    },
  );

  it("retains denied bootstrap shutdown and safely reports combined failures until a later stop", async () => {
    const f = await fixture("openai", "failure");
    const signalFault = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      const ready = f.records().find((entry) => entry.kind === "ready");
      if (ready && pid === -ready.pgid && (signal === "SIGTERM" || signal === "SIGKILL")) {
        throw Object.assign(new Error("synthetic group signal denied"), { code: "EPERM" });
      }
      return realKill(pid, signal);
    });
    const starting = f.track(f.start());
    const [ready] = await f.ready();
    const error = await bounded(starting);
    expect(error).toBeInstanceOf(AggregateError);
    const diagnostic = inspect(error, { depth: null });
    expect(diagnostic).toContain("OpenClaw CLI exited 17");
    expect(diagnostic).toContain("process tree remained alive");
    expect(ready!.submittedKey).toMatch(/^sk-qa-mock-[a-f0-9]{32}$/u);
    expect(diagnostic).not.toContain(ready!.submittedKey);
    expect(diagnostic).not.toContain("diagnostic ".repeat(400));
    const stopped = await bounded(f.owner.stop());
    expect(stopped.process).toBe("unconfirmed");
    expect(stopped.errors.length).toBeGreaterThan(0);
    expect(inspect(stopped, { depth: null })).not.toContain(ready!.submittedKey);
    expect(isQaPosixProcessGroupAlive(ready!.pgid)).toBe(true);
    expect(existsSync(ready!.tempRoot!)).toBe(true);
    expect(f.records().some((entry) => entry.kind === "gateway")).toBe(false);
    signalFault.mockRestore();
    await expect(bounded(f.owner.stop())).resolves.toEqual(stoppedResult);
    f.assertStopped();
    expect(existsSync(ready!.tempRoot!)).toBe(false);
  });
});

it.each([
  {
    file: "hook-agent-account-routing",
    shared: true,
    load: () => import("./hook-agent-account-routing.e2e.test.js"),
  },
  {
    file: "managed-gateway-service-lifecycle",
    shared: false,
    load: () => import("./managed-gateway-service-lifecycle.e2e.test.js"),
  },
])("registers cleanup before $file startup settles", async ({ shared, load }) => {
  const starts: Array<() => Promise<void>> = [];
  const teardownHooks: Array<() => Promise<void>> = [];
  const cleaned: string[] = [];
  const entered = createDeferred<void>();
  const startup = createDeferred<never>();
  let pending: Promise<void> | undefined;
  try {
    // mock-isolation: Hold startup without launching another Gateway or touching real state.
    vi.doMock("./gateway-child.js", () => ({
      createQaGatewayChild: () => ({
        start: () => {
          entered.resolve();
          return startup.promise;
        },
        stop: async () => {
          cleaned.push("gateway");
          return { errors: [] };
        },
      }),
    }));
    // mock-isolation: Track provider disposal without opening a network listener.
    vi.doMock("./providers/server-runtime.js", () => ({
      startQaProviderServer: async () => ({
        baseUrl: "http://127.0.0.1:1",
        stop: async () => {
          cleaned.push("provider");
        },
      }),
    }));
    // mock-isolation: Track lab disposal without creating a workspace or server.
    vi.doMock("./lab-server.js", () => ({
      startQaLabServer: async () => ({
        state: {},
        listenUrl: "http://127.0.0.1:1",
        stop: async () => {
          cleaned.push("lab");
        },
      }),
    }));
    // mock-isolation: The pending-start proof never delivers a channel message.
    vi.doMock("./qa-channel-transport.js", () => ({ createQaChannelTransport: () => ({}) }));
    vi.doMock("vitest", () => ({
      describe: (_name: string, body: () => void) => body(),
      beforeAll: (body: () => Promise<void>) => starts.push(body),
      afterAll: (body: () => Promise<void>) => teardownHooks.push(body),
      afterEach: (body: () => Promise<void>) => teardownHooks.push(body),
      it: (_name: string, _options: unknown, body: () => Promise<void>) => {
        if (!shared) {
          starts.push(body);
        }
      },
      expect,
      vi,
    }));
    await load();
    pending = starts[0]!();
    await bounded(
      Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("fixture completed before Gateway startup");
        }),
      ]),
    );
    expect(cleaned).toEqual([]);
    for (const cleanup of teardownHooks) {
      await cleanup();
    }
    expect(cleaned).toEqual(shared ? ["gateway", "provider", "lab"] : ["gateway", "provider"]);
  } finally {
    // Release the synthetic hold and join the fixture before retiring its mocks.
    startup.reject(new Error("synthetic pending-start release"));
    await Promise.allSettled([startup.promise, pending]);
    vi.doUnmock("vitest");
    vi.doUnmock("./gateway-child.js");
    vi.doUnmock("./providers/server-runtime.js");
    vi.doUnmock("./lab-server.js");
    vi.doUnmock("./qa-channel-transport.js");
    vi.resetModules();
  }
});

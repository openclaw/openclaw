import * as childProcess from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startFixtureAttempt } from "./attempt-startup-retry.test-support.js";
import { CodexAppServerClient } from "./client.js";
import { threadStartResult } from "./codex-app-server.test-fixtures.js";
import { resolveCodexAppServerRuntimeOptions, type CodexPluginConfig } from "./config.js";
import { defaultCodexPluginMetadataCache } from "./plugin-metadata-cache.js";
import {
  resetCodexTestBindingStore,
  testCodexAppServerBindingStore,
} from "./session-binding.test-helpers.js";
import {
  clearSharedCodexAppServerClientAndWait,
  createIsolatedCodexAppServerClient,
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import { findCodexAppServerSpawnError } from "./spawn-error.js";
import * as processSnapshot from "./transport-process-snapshot.js";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
}));

vi.mock("./desktop-generation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./desktop-generation.js")>()),
  waitForCodexDesktopGeneration: async () => undefined,
}));

const tempRoots = new Set<string>();
const cleanups: Array<() => void | Promise<void>> = [];

async function createStartupFailureFixture(
  mode: "transient" | "persistent" | "overload" | "refusal",
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-startup-retry-"));
  tempRoots.add(root);
  const fixturePath = path.join(root, "startup-failure.mjs");
  const spawnCountPath = path.join(root, "spawn-count");
  const requestLogPath = path.join(root, "requests.log");
  const codexHome = path.join(root, "codex-home");
  await fs.writeFile(
    fixturePath,
    [
      'import fs from "node:fs";',
      'import readline from "node:readline";',
      "const [spawnCountPath, mode, codexHome, requestLogPath] = process.argv.slice(2);",
      'const attempt = Number(fs.existsSync(spawnCountPath) ? fs.readFileSync(spawnCountPath, "utf8") : 0) + 1;',
      'fs.writeFileSync(spawnCountPath, String(attempt), "utf8");',
      'process.stdout.write(JSON.stringify({ method: "fixture/ready" }) + "\\n");',
      'if (mode === "persistent" || (mode === "transient" && attempt === 1)) {',
      "  console.error(`Error: failed to initialize sqlite state runtime under ${codexHome}: failed to initialize state runtime at ${codexHome}`);",
      // Keep the persistent fixture alive through process registration so this
      // case reaches the startup owner; immediate-exit registration has its own case.
      '  if (mode === "persistent") setTimeout(() => { process.exitCode = 1; }, 1_000);',
      "  else process.exitCode = 1;",
      "} else {",
      '  if (mode === "refusal") fs.writeSync(2, "startup diagnostic: inspection probe\\n");',
      "  const lines = readline.createInterface({ input: process.stdin });",
      '  lines.on("line", (line) => {',
      "    const message = JSON.parse(line);",
      "    if (message.id === undefined) return;",
      "    fs.appendFileSync(requestLogPath, `${message.method}\\n`);",
      '    if (mode === "overload" && message.method === "thread/resume") {',
      '      process.stdout.write(`${JSON.stringify({ id: message.id, error: { code: -32001, message: "Server overloaded; retry later." } })}\\n`);',
      "      return;",
      "    }",
      '    const result = { initialize: { userAgent: "openclaw/0.149.0 (macOS; test)" },',
      '      "config/read": { config: {}, origins: {}, layers: [] },',
      '      "configRequirements/read": { requirements: null }, "skills/list": { data: [] }',
      `    }[message.method] ?? ${JSON.stringify(threadStartResult("thread-recovered", "/repo"))};`,
      // Managed resume requires an unloaded thread before it can reach the overload rejection.
      '    if (message.method === "thread/read") result.thread.status = { type: "notLoaded" };',
      "    process.stdout.write(`${JSON.stringify({ id: message.id, result })}\\n`);",
      "  });",
      "}",
    ].join("\n"),
    "utf8",
  );
  const pluginConfig = {
    appServer: {
      transport: "stdio",
      command: process.execPath,
      args: [fixturePath, spawnCountPath, mode, codexHome, requestLogPath],
      requestTimeoutMs: 5_000,
    },
  } satisfies CodexPluginConfig;
  return { root, spawnCountPath, requestLogPath, pluginConfig };
}

function waitForFixtureReady(child: childProcess.ChildProcess): Promise<void> {
  const ready = Promise.withResolvers<void>();
  let output = "";
  const finish = (error?: Error) => {
    child.stdout?.off("data", onData);
    child.off("close", onClose);
    child.off("error", finish);
    if (error) {
      ready.reject(error);
    } else {
      ready.resolve();
    }
  };
  const onData = (chunk: Buffer) => {
    output += chunk.toString();
    if (output.includes('"fixture/ready"')) {
      finish();
    }
  };
  const onClose = () => finish(new Error("Fixture closed before readiness"));
  child.stdout?.on("data", onData);
  // Exit can precede buffered stdout. Only close proves readiness is absent.
  child.once("close", onClose);
  child.once("error", finish);
  return ready.promise;
}

function observeFixtureSpawn(fixture: { root: string }, waitForReady = true) {
  const spawn = childProcess.spawn;
  const observed: {
    child?: childProcess.ChildProcess;
    ready?: Promise<void>;
    closed?: Promise<unknown>;
  } = {};
  vi.spyOn(childProcess, "spawn").mockImplementation((...args) => {
    const spawned = spawn(...args);
    if (
      Array.isArray(args[1]) &&
      args[1].includes(path.join(fixture.root, "startup-failure.mjs"))
    ) {
      observed.child = spawned;
      observed.ready = waitForReady ? waitForFixtureReady(spawned) : undefined;
      observed.closed = once(spawned, "close");
    }
    return spawned;
  });
  cleanups.push(async () => {
    const child = observed.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
  });
  return observed;
}
function clientOptions(fixture: { root: string; pluginConfig: CodexPluginConfig }) {
  return {
    startOptions: resolveCodexAppServerRuntimeOptions({ pluginConfig: fixture.pluginConfig }).start,
    agentDir: path.join(fixture.root, "agent"),
  };
}

describe("Codex app-server startup retry", () => {
  beforeEach(async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-startup-state-"));
    tempRoots.add(stateDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("CODEX_API_KEY", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    await clearSharedCodexAppServerClientAndWait();
    defaultCodexPluginMetadataCache.clear();
    resetCodexTestBindingStore();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
    await clearSharedCodexAppServerClientAndWait();
    defaultCodexPluginMetadataCache.clear();
    vi.unstubAllEnvs();
    for (const root of tempRoots) {
      await fs.rm(root, { recursive: true, force: true });
    }
    tempRoots.clear();
  });

  it.skipIf(process.platform === "win32").each(["snapshot", "command"] as const)(
    "keeps live-child %s registration failures non-retryable for shared startup",
    async (failure) => {
      const fixture = await createStartupFailureFixture("refusal");
      const readSnapshot = processSnapshot.readCodexAppServerProcessSnapshot;
      const readCommand = processSnapshot.readCodexAppServerProcessCommand;
      const observed = observeFixtureSpawn(fixture);
      vi.spyOn(processSnapshot, "readCodexAppServerProcessSnapshot").mockImplementation(
        async (...args) => {
          if (!observed.child) {
            return readSnapshot(...args);
          }
          await observed.ready;
          expect(observed.child).toMatchObject({ exitCode: null, signalCode: null });
          return failure === "snapshot"
            ? readSnapshot(performance.now() - 1)
            : readSnapshot(...args);
        },
      );
      vi.spyOn(processSnapshot, "readCodexAppServerProcessCommand").mockImplementation(
        async (...args) => {
          const command = await readCommand(...args);
          return failure === "command" ? readCommand(args[0], performance.now() - 1) : command;
        },
      );
      const error = await startFixtureAttempt(fixture, getLeasedSharedCodexAppServerClient).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("Process inspection exceeded its deadline");
      expect((error as Error).message).toContain("startup diagnostic: inspection probe");
      expect(await fs.readFile(fixture.spawnCountPath, "utf8")).toBe("1");
      await expect(fs.access(fixture.requestLogPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(observed.child).toMatchObject({
        exitCode: 0,
        signalCode: null,
        stdout: { destroyed: true },
        stderr: { destroyed: true },
      });
    },
  );

  it.skipIf(process.platform === "win32").each(["natural exit", "live child"])(
    "preserves assertCurrent refusal over a %s during registration",
    async (mode) => {
      const fixture = await createStartupFailureFixture(
        mode === "natural exit" ? "transient" : "refusal",
      );
      const refusal = new Error("startup owner revoked");
      let current = true;
      const observed = observeFixtureSpawn(fixture, mode === "live child");
      const readSnapshot = processSnapshot.readCodexAppServerProcessSnapshot;
      vi.spyOn(processSnapshot, "readCodexAppServerProcessSnapshot").mockImplementation(
        async (...args) => {
          if (mode === "natural exit") {
            await observed.closed;
          } else {
            await observed.ready;
          }
          const rows = await readSnapshot(...args);
          current = false;
          return rows;
        },
      );
      await expect(
        CodexAppServerClient.start(
          resolveCodexAppServerRuntimeOptions({ pluginConfig: fixture.pluginConfig }).start,
          () => {
            if (!current) {
              throw refusal;
            }
          },
        ),
      ).rejects.toBe(refusal);
      expect(observed.child).toMatchObject({
        exitCode: mode === "natural exit" ? 1 : 0,
        signalCode: null,
      });
      await expect(fs.access(fixture.requestLogPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.skipIf(process.platform === "win32").each([
    ["shared", getLeasedSharedCodexAppServerClient],
    ["isolated", createIsolatedCodexAppServerClient],
  ] as const)("preserves cancellation during %s registration", async (mode, factory) => {
    const fixture = await createStartupFailureFixture("refusal");
    const controller = new AbortController();
    const readCommand = processSnapshot.readCodexAppServerProcessCommand;
    const observed = observeFixtureSpawn(fixture);
    vi.spyOn(processSnapshot, "readCodexAppServerProcessCommand").mockImplementation(
      async (...args) => {
        await observed.ready;
        const command = await readCommand(...args);
        controller.abort();
        return command;
      },
    );
    const options = {
      ...clientOptions(fixture),
      authProfileStore: { version: 1 as const, profiles: {} },
    };
    await expect(factory({ ...options, abandonSignal: controller.signal })).rejects.toMatchObject({
      code: "CODEX_APP_SERVER_STARTUP_CANCELLED",
      reason: "aborted",
    });
    if (mode === "shared") {
      const client = await getLeasedSharedCodexAppServerClient(options);
      expect(observed.child?.exitCode).toBeNull();
      expect(await fs.readFile(fixture.requestLogPath, "utf8")).toContain("initialize\n");
      releaseLeasedSharedCodexAppServerClient(client);
      await clearSharedCodexAppServerClientAndWait();
    }
    await observed.closed;
    expect(observed.child).toMatchObject({ exitCode: 0, signalCode: null });
    expect(await fs.readFile(fixture.spawnCountPath, "utf8")).toBe("1");
    if (mode === "isolated") {
      await expect(fs.access(fixture.requestLogPath)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("rejects persistent startup failure without retrying", async () => {
    const fixture = await createStartupFailureFixture("persistent");
    await expect(startFixtureAttempt(fixture)).rejects.toThrow(
      "failed to initialize sqlite state runtime",
    );
    expect(await fs.readFile(fixture.spawnCountPath, "utf8")).toBe("1");
  });

  it("preserves spawn failure without retrying", async () => {
    const fixture = await createStartupFailureFixture("refusal");
    const command = path.join(fixture.root, "missing-executable");
    fixture.pluginConfig.appServer.command = command;
    const spawnSpy = vi.spyOn(childProcess, "spawn");
    const error = await startFixtureAttempt(fixture).catch((caught: unknown) => caught);
    expect(findCodexAppServerSpawnError(error)).toMatchObject({
      command,
      cause: expect.objectContaining({ code: "ENOENT" }),
    });
    await expect(startFixtureAttempt(fixture)).rejects.toBe(error);
    expect(spawnSpy.mock.calls.filter(([program]) => program === command)).toHaveLength(1);
  });

  it("preserves the shared client and binding on an overloaded resume with a sibling lease", async () => {
    const fixture = { ...(await createStartupFailureFixture("overload")), disableTools: false };
    const sibling = await startFixtureAttempt(fixture);
    cleanups.push(async () => {
      sibling.releaseSharedClientLease();
      await sibling.client.closeAndWait();
    });
    sibling.turnRoute.release();
    const identity = {
      kind: "session" as const,
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:session-1",
    };
    const binding = testCodexAppServerBindingStore.read(identity);
    expect(binding?.threadId).toBe("thread-recovered");
    // An unrelated lease must not hide a native refusal or lose its healthy client.
    await expect(startFixtureAttempt(fixture)).rejects.toMatchObject({
      name: "CodexAppServerRpcError",
      code: -32_001,
      method: "thread/resume",
    });
    expect(testCodexAppServerBindingStore.read(identity)).toEqual(binding);

    await expect(
      sibling.client.request("thread/read", {
        threadId: "thread-recovered",
        includeTurns: false,
      }),
    ).resolves.toMatchObject({ thread: { id: "thread-recovered" } });
    sibling.releaseSharedClientLease();
    expect(sibling.client.getCloseError()).toBeUndefined();

    const reacquired = await getLeasedSharedCodexAppServerClient(clientOptions(fixture));
    cleanups.unshift(() => {
      releaseLeasedSharedCodexAppServerClient(reacquired);
    });
    expect(reacquired).toBe(sibling.client);
    expect(reacquired.getCloseError()).toBeUndefined();
    expect(await fs.readFile(fixture.spawnCountPath, "utf8")).toBe("1");
  });
});

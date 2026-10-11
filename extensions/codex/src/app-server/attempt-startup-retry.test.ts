import * as childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
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

async function createStartupFailureFixture(
  mode: "transient" | "persistent" | "unsupported" | "overload" | "refusal",
) {
  const root = path.join(os.tmpdir(), `openclaw-codex-startup-retry-${randomUUID()}`);
  tempRoots.add(root);
  const fixturePath = path.join(root, "startup-failure.mjs");
  const spawnCountPath = path.join(root, "spawn-count");
  const requestLogPath = path.join(root, "requests.log");
  const codexHome = path.join(root, "codex-home");
  await fs.mkdir(root, { recursive: true });
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
      '    const result = message.method === "initialize"',
      '      ? { userAgent: `openclaw/${mode === "unsupported" ? "0.1.0" : "0.149.0"} (macOS; test)` }',
      '      : message.method === "config/read"',
      "        ? { config: {}, origins: {}, layers: [] }",
      '        : message.method === "configRequirements/read"',
      "          ? { requirements: null }",
      '          : message.method === "skills/list"',
      "            ? { data: [] }",
      `            : ${JSON.stringify(threadStartResult("thread-recovered", "/repo"))};`,
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
  return new Promise((resolve, reject) => {
    let output = "";
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes('"fixture/ready"')) {
        cleanup();
        resolve();
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Fixture closed before readiness"));
    };
    const cleanup = () => {
      child.stdout?.off("data", onData);
      child.off("close", onClose);
      child.off("error", onError);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    child.stdout?.on("data", onData);
    // Exit can precede buffered stdout. Only close proves readiness is absent.
    child.once("close", onClose);
    child.once("error", onError);
  });
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
    await clearSharedCodexAppServerClientAndWait();
    defaultCodexPluginMetadataCache.clear();
    vi.unstubAllEnvs();
    for (const root of tempRoots) {
      await fs.rm(root, { recursive: true, force: true });
    }
    tempRoots.clear();
  });

  it.skipIf(process.platform === "win32")(
    "keeps live-child registration failures non-retryable for shared startup",
    async () => {
      for (const failure of ["snapshot", "command", "commit"] as const) {
        const fixture = await createStartupFailureFixture("refusal");
        const { createPluginStateSyncKeyedStore } =
          await import("openclaw/plugin-sdk/plugin-state-store-runtime");
        const store = createPluginStateSyncKeyedStore("codex", {
          namespace: "app-server-processes",
          maxEntries: 512,
          overflowPolicy: "reject-new",
        });
        const spawn = childProcess.spawn;
        const readSnapshot = processSnapshot.readCodexAppServerProcessSnapshot;
        const readCommand = processSnapshot.readCodexAppServerProcessCommand;
        let child: childProcess.ChildProcess | undefined;
        let ready: Promise<void> | undefined;
        const spawnSpy = vi.spyOn(childProcess, "spawn").mockImplementation((...args) => {
          const spawned = spawn(...args);
          if (
            Array.isArray(args[1]) &&
            args[1].includes(path.join(fixture.root, "startup-failure.mjs"))
          ) {
            child = spawned;
            ready = waitForFixtureReady(spawned);
          }
          return spawned;
        });
        const snapshotSpy = vi
          .spyOn(processSnapshot, "readCodexAppServerProcessSnapshot")
          .mockImplementation(async (...args) => {
            if (!child) {
              return readSnapshot(...args);
            }
            await ready;
            expect(child.exitCode).toBeNull();
            expect(child.signalCode).toBeNull();
            return failure === "snapshot" ? readSnapshot(Date.now() - 1) : readSnapshot(...args);
          });
        const commandSpy = vi
          .spyOn(processSnapshot, "readCodexAppServerProcessCommand")
          .mockImplementation(async (...args) => {
            const command = await readCommand(...args);
            if (failure === "commit") {
              // Fill the real reject-new store after orphan inspection, so the
              // synchronous registration commit, not a mock, refuses the live child.
              for (let index = 0; index < 512; index++) {
                store.register(`capacity-${index}`, {});
              }
            }
            return failure === "command" ? readCommand(args[0], Date.now() - 1) : command;
          });
        try {
          const error = await startFixtureAttempt(
            fixture,
            getLeasedSharedCodexAppServerClient,
          ).catch((caught: unknown) => caught);
          expect(error).toBeInstanceOf(Error);
          expect((error as Error).message).toContain(
            failure === "commit" ? "512-row limit" : "Process inspection exceeded its deadline",
          );
          expect((error as Error).message).toContain("startup diagnostic: inspection probe");
          expect(await fs.readFile(fixture.spawnCountPath, "utf8")).toBe("1");
          await expect(fs.access(fixture.requestLogPath)).rejects.toMatchObject({ code: "ENOENT" });
          expect(child?.exitCode).toBe(0);
          expect(child?.signalCode).toBeNull();
          expect(child?.stdout?.destroyed).toBe(true);
          expect(child?.stderr?.destroyed).toBe(true);
        } finally {
          spawnSpy.mockRestore();
          snapshotSpy.mockRestore();
          commandSpy.mockRestore();
          store.clear();
          if (child && child.exitCode === null && child.signalCode === null) {
            const exited = once(child, "exit");
            child.kill("SIGKILL");
            await exited;
          }
        }
      }
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
      const spawn = childProcess.spawn;
      let child: childProcess.ChildProcess | undefined;
      let ready: Promise<void> | undefined;
      let closed: Promise<unknown> | undefined;
      const spawnSpy = vi.spyOn(childProcess, "spawn").mockImplementation((...args) => {
        const spawned = spawn(...args);
        if (
          Array.isArray(args[1]) &&
          args[1].includes(path.join(fixture.root, "startup-failure.mjs"))
        ) {
          child = spawned;
          ready = mode === "live child" ? waitForFixtureReady(spawned) : undefined;
          closed = once(spawned, "close");
        }
        return spawned;
      });
      const readSnapshot = processSnapshot.readCodexAppServerProcessSnapshot;
      const snapshotSpy = vi
        .spyOn(processSnapshot, "readCodexAppServerProcessSnapshot")
        .mockImplementation(async (...args) => {
          if (mode === "natural exit") {
            await closed;
          } else {
            await ready;
          }
          const rows = await readSnapshot(...args);
          current = false;
          return rows;
        });
      try {
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
        expect(child?.exitCode).toBe(mode === "natural exit" ? 1 : 0);
        expect(child?.signalCode).toBeNull();
        await expect(fs.access(fixture.requestLogPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        spawnSpy.mockRestore();
        snapshotSpy.mockRestore();
      }
    },
  );

  it.skipIf(process.platform === "win32").each([
    ["shared", getLeasedSharedCodexAppServerClient],
    ["isolated", createIsolatedCodexAppServerClient],
  ] as const)("preserves cancellation during %s registration", async (_mode, factory) => {
    const fixture = await createStartupFailureFixture("refusal");
    const controller = new AbortController();
    const spawn = childProcess.spawn;
    const readCommand = processSnapshot.readCodexAppServerProcessCommand;
    let child: childProcess.ChildProcess | undefined;
    let ready: Promise<void> | undefined;
    let closed: Promise<unknown> | undefined;
    const spawnSpy = vi.spyOn(childProcess, "spawn").mockImplementation((...args) => {
      const spawned = spawn(...args);
      if (
        Array.isArray(args[1]) &&
        args[1].includes(path.join(fixture.root, "startup-failure.mjs"))
      ) {
        child = spawned;
        ready = waitForFixtureReady(spawned);
        closed = once(spawned, "close");
      }
      return spawned;
    });
    const commandSpy = vi
      .spyOn(processSnapshot, "readCodexAppServerProcessCommand")
      .mockImplementation(async (...args) => {
        await ready;
        const command = await readCommand(...args);
        controller.abort();
        return command;
      });
    try {
      await expect(
        factory({
          startOptions: resolveCodexAppServerRuntimeOptions({ pluginConfig: fixture.pluginConfig })
            .start,
          agentDir: path.join(fixture.root, "agent"),
          authProfileStore: { version: 1, profiles: {} },
          abandonSignal: controller.signal,
        }),
      ).rejects.toMatchObject({ code: "CODEX_APP_SERVER_STARTUP_CANCELLED", reason: "aborted" });
      await closed;
      expect(child?.exitCode).toBe(0);
      expect(child?.signalCode).toBeNull();
      expect(await fs.readFile(fixture.spawnCountPath, "utf8")).toBe("1");
      await expect(fs.access(fixture.requestLogPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      spawnSpy.mockRestore();
      commandSpy.mockRestore();
    }
  });

  it("returns the initial sqlite startup failure without replaying native startup", async () => {
    const fixture = await createStartupFailureFixture("persistent");

    await expect(startFixtureAttempt(fixture)).rejects.toThrow(
      "failed to initialize sqlite state runtime",
    );
    expect(await fs.readFile(fixture.spawnCountPath, "utf8")).toBe("1");
  });

  it("rejects an unsupported app-server version without retrying", async () => {
    const fixture = await createStartupFailureFixture("unsupported");

    await expect(startFixtureAttempt(fixture)).rejects.toThrow(
      /app-server .* or newer is required/i,
    );
    expect(await fs.readFile(fixture.spawnCountPath, "utf8")).toBe("1");
  });

  it("preserves spawn failure without retrying", async () => {
    const fixture = await createStartupFailureFixture("refusal");
    const command = path.join(fixture.root, "missing-executable");
    fixture.pluginConfig.appServer.command = command;
    const spawnSpy = vi.spyOn(childProcess, "spawn");
    try {
      const error = await startFixtureAttempt(fixture).catch((caught: unknown) => caught);
      expect(findCodexAppServerSpawnError(error)).toMatchObject({
        command,
        cause: expect.objectContaining({ code: "ENOENT" }),
      });
      await expect(startFixtureAttempt(fixture)).rejects.toBe(error);
      expect(spawnSpy.mock.calls.filter(([program]) => program === command)).toHaveLength(1);
    } finally {
      spawnSpy.mockRestore();
    }
  });

  it("preserves the shared client and binding on an overloaded resume with a sibling lease", async () => {
    const fixture = await createStartupFailureFixture("overload");
    const sibling = await startFixtureAttempt(fixture);
    sibling.turnRoute.release();
    const identity = {
      kind: "session" as const,
      agentId: "agent-1",
      sessionId: "session-1",
      sessionKey: "agent:agent-1:session-1",
    };
    try {
      const binding = testCodexAppServerBindingStore.read(identity);
      expect(binding?.threadId).toBe("thread-recovered");
      const requestsBeforeResume = await fs.readFile(fixture.requestLogPath, "utf8");

      // An unrelated lease must not hide a native refusal or lose its healthy client.
      await expect(startFixtureAttempt(fixture)).rejects.toMatchObject({
        name: "CodexAppServerRpcError",
        code: -32_001,
        method: "thread/resume",
      });
      const requests = await fs.readFile(fixture.requestLogPath, "utf8");
      expect(new Set(requests.slice(requestsBeforeResume.length).trim().split("\n"))).toEqual(
        new Set(["config/read", "configRequirements/read", "thread/read", "thread/resume"]),
      );
      expect(testCodexAppServerBindingStore.read(identity)).toEqual(binding);

      await expect(
        sibling.client.request("thread/read", {
          threadId: "thread-recovered",
          includeTurns: false,
        }),
      ).resolves.toMatchObject({ thread: { id: "thread-recovered" } });
      sibling.releaseSharedClientLease();
      expect(sibling.client.getCloseError()).toBeUndefined();

      const reacquired = await getLeasedSharedCodexAppServerClient({
        startOptions: resolveCodexAppServerRuntimeOptions({ pluginConfig: fixture.pluginConfig })
          .start,
        agentDir: path.join(fixture.root, "agent"),
      });
      try {
        expect(reacquired).toBe(sibling.client);
        expect(reacquired.getCloseError()).toBeUndefined();
        expect(await fs.readFile(fixture.spawnCountPath, "utf8")).toBe("1");
      } finally {
        releaseLeasedSharedCodexAppServerClient(reacquired);
      }
    } finally {
      sibling.releaseSharedClientLease();
      await sibling.client.closeAndWait();
    }
  });
});

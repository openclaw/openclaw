import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as waitForProcessTick } from "node:timers/promises";
import type {
  CliBackendExecuteContext,
  CliBackendLiveSessionHandle,
  CliBackendPreparedExecution,
} from "openclaw/plugin-sdk/cli-backend";
import { formatErrorMessageForDisplay } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OwnedStdioProcess } from "openclaw/plugin-sdk/process-runtime";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAnthropicCliBackend } from "./cli-backend.js";
import { discoverClaudeCliModels } from "./cli-model-discovery.js";
import * as cliProcess from "./cli-process.js";
import type { ClaudeCliSecretInput } from "./cli-process.js";
import { createClaudeCliTransport } from "./cli-transport.js";
import { executeClaudeCli } from "./cli.runtime.js";

const roots: string[] = [];
const sessions = new Set<CliBackendLiveSessionHandle>();

const PROTOCOL_CHILD = `
  import { createInterface } from "node:readline";
  import { readFileSync, writeSync } from "node:fs";
  const credential = process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
    ? readFileSync(3, "utf8") : "";
  const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
  let delayedDiagnostic = "";
  createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.type === "control_request") {
      send({ type: "control_response", response: {
        subtype: "success", request_id: message.request_id, response: {},
      } });
    } else if (message.type === "user") {
      const text = message.message.content;
      if (delayedDiagnostic) {
        writeSync(2, delayedDiagnostic);
        delayedDiagnostic = "";
      }
      if (text === "fail silently") process.exit(1);
      if (text === "fail noisily" || text === "exit without result") {
        writeSync(2, "PermissionError: current turn failed " + credential + "\\n");
        writeSync(2, "process environment: " + process.env.OPENCLAW_MCP_TOKEN + "\\n");
        process.exit(text === "exit without result" ? 0 : 1);
      }
      if (text === "success with stderr") writeSync(2, "previous turn diagnostic\\n");
      if (text === "success with delayed stderr") {
        delayedDiagnostic = "previous turn diagnostic " + credential + "\\n";
      }
      send({ type: "result", subtype: "success", is_error: false, result: "ok",
        session_id: "synthetic-session", duration_ms: 1, duration_api_ms: 1,
        num_turns: 1, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [],
      });
    }
  });
`;

const STARTUP_HOOK_CHILD = String.raw`
  import { createInterface } from "node:readline";
  import { writeFileSync } from "node:fs";
  const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
  let turn = 0;
  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line);
    if (message.type === "control_request") {
      for (let index = 0; index < 40; index++) {
        send({ type: "system", subtype: index % 2 ? "hook_response" : "hook_started", hook_id: String(index), pid: process.pid });
      }
      if (process.env.CLAUDE_FIXTURE_SCENARIO === "cancel") continue;
      send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
    } else if (message.type === "user") {
      writeFileSync("user.received", message.message.content);
      send({ type: "result", subtype: "success", result: JSON.stringify({ pid: process.pid, turn: ++turn, input: message.message.content }) });
    }
  }
`;

afterEach(async () => {
  for (const session of sessions) {
    session.close("restart");
    await session.waitForExit();
  }
  sessions.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function contextForChild(
  source: string,
  signal?: AbortSignal,
): Promise<CliBackendExecuteContext> {
  const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-claude-stderr-"));
  roots.push(root);
  const command = path.join(root, "claude.mjs");
  await writeFile(command, source);
  return {
    command: process.execPath,
    args: [command],
    cwd: root,
    env: { PATH: process.env.PATH ?? "", HOME: root, CLAUDE_CONFIG_DIR: root },
    prompt: "Synthetic subprocess diagnostic probe.",
    systemPrompt: "Synthetic subprocess diagnostic probe.",
    modelId: "claude-sonnet-4-6",
    useResume: false,
    timeoutMs: 10_000,
    abortSignal: signal ?? AbortSignal.timeout(10_000),
    requestToolPermission: async () => ({ behavior: "deny", message: "No tools in this probe." }),
    requestUserInput: async () => ({ status: "cancelled", message: "No input in this probe." }),
  };
}

async function collect(
  context: CliBackendExecuteContext,
  secretInput?: Parameters<typeof executeClaudeCli>[1],
  execute = executeClaudeCli,
) {
  const events: Record<string, unknown>[] = [];
  for await (const event of execute(context, secretInput)) {
    events.push(event);
  }
  return events;
}

function observeChild(
  observe: (
    child: OwnedStdioProcess,
    owner: ReturnType<typeof cliProcess.createClaudeCliProcessOwner>,
  ) => void | Promise<void>,
) {
  const createOwner = cliProcess.createClaudeCliProcessOwner;
  vi.spyOn(cliProcess, "createClaudeCliProcessOwner").mockImplementation((...args) => {
    const owner = createOwner(...args);
    const spawn = owner.spawn;
    vi.spyOn(owner, "spawn").mockImplementation(async (options) => {
      const child = await spawn(options);
      await observe(child, owner);
      return child;
    });
    return owner;
  });
}

function attachLiveSession(context: CliBackendExecuteContext) {
  let current: CliBackendLiveSessionHandle | undefined;
  context.liveSession = {
    fingerprint: "synthetic-process-policy",
    current: () => current,
    restart: async () => {
      const previous = current;
      previous?.close("restart");
      await previous?.waitForExit();
    },
    register: (handle) => {
      current = handle;
      sessions.add(handle);
    },
    activate: () => {},
    remove: (handle) => {
      if (current === handle) {
        current = undefined;
      }
    },
  };
  return () => current;
}

// The transport joins its root and signal dispatch, not this foreign descendant's exit.
async function waitForDescendantExit(pid: number, signal: AbortSignal): Promise<void> {
  try {
    for (;;) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      await waitForProcessTick(10, undefined, { signal });
    }
  } catch (cause) {
    throw new Error(`Claude stderr descendant ${pid} did not exit before the test aborted`, {
      cause,
    });
  }
}

describe("Claude subprocess diagnostics through the direct CLI transport", () => {
  it("delivers startup hook bursts in order and completes the first and warm turns", async ({
    signal,
  }) => {
    const context = await contextForChild(STARTUP_HOOK_CHILD, signal);
    attachLiveSession(context);
    const records = await collect(context);
    expect(
      records.filter((record) => record.type === "system").map((record) => record.hook_id),
    ).toEqual(Array.from({ length: 40 }, (_, index) => String(index)));
    expect(records).toHaveLength(41);
    const first = JSON.parse(String(records.at(-1)?.result));
    expect(first).toMatchObject({ turn: 1, input: context.prompt });
    const second = await collect({ ...context, prompt: "warm input" });
    expect(second).toHaveLength(1);
    expect(JSON.parse(String(second.at(-1)?.result))).toEqual({
      pid: first.pid,
      turn: 2,
      input: "warm input",
    });
  });

  it.for(["iterator return", "abort"] as const)(
    "cancels during startup hooks before initialization accepts user input: %s",
    async (cancellation, { signal }) => {
      const controller = new AbortController();
      const context = await contextForChild(
        STARTUP_HOOK_CHILD,
        AbortSignal.any([controller.signal, signal]),
      );
      context.env.CLAUDE_FIXTURE_SCENARIO = "cancel";
      const current = attachLiveSession(context);
      const events = executeClaudeCli(context);
      const iterator = events[Symbol.asyncIterator]();
      const first = await withinTest(iterator.next(), signal);
      expect(first.value).toMatchObject({ type: "system", subtype: "hook_started", hook_id: "0" });
      if (cancellation === "abort") {
        const reason = new Error("Synthetic cancellation before initialization.");
        controller.abort(reason);
        const remaining = async () => {
          for await (const record of events) {
            void record;
          }
        };
        await expect(withinTest(remaining(), signal)).rejects.toBe(reason);
      } else {
        await withinTest(Promise.resolve(iterator.return?.()), signal);
      }
      expect(current()).toBeUndefined();
      await expect(access(path.join(context.cwd, "user.received"))).rejects.toThrow();
      expect(() => process.kill(Number(first.value?.pid), 0)).toThrow();
    },
  );

  it("waits for startup and child extinction when a session closes during spawn", async ({
    signal,
  }) => {
    const context = await contextForChild(PROTOCOL_CHILD);
    const current = attachLiveSession(context);
    const spawned = createDeferred<void>();
    const release = createDeferred<void>();
    let extinct = false;
    observeChild(async (child) => {
      void child.waitForExtinction?.().then(
        () => {
          extinct = true;
        },
        () => {},
      );
      spawned.resolve();
      await release.promise;
    });
    const running = collect(context);
    void running.catch(() => {});
    let waiting: Promise<void> | undefined;
    try {
      await withinTest(spawned.promise, signal);
      const session = current();
      if (!session) {
        throw new Error("Expected the starting session to be registered.");
      }
      session.close("restart");
      let finished = false;
      waiting = session.waitForExit().then(() => {
        finished = true;
      });
      void waiting.catch(() => {});
      // Let a prematurely resolved exit promise run before releasing startup.
      await Promise.resolve();
      expect(finished).toBe(false);
      release.resolve();
      await withinTest(waiting, signal);
      expect(extinct).toBe(true);
      await expect(running).rejects.toThrow("Claude CLI live session closed.");
    } finally {
      release.resolve();
      await Promise.allSettled([running, waiting]);
    }
  });

  it("preserves a missing executable's native spawn error", async () => {
    const context = await contextForChild("");
    context.command = path.join(context.cwd, "missing-claude");
    await expect(collect(context)).rejects.toMatchObject({
      code: "ENOENT",
      path: context.command,
      syscall: `spawn ${context.command}`,
    });
  });

  it.runIf(process.platform === "linux")(
    "raises the CLI child OOM score without changing its shim identity or the parent score",
    async () => {
      const context = await contextForChild(`
        import { readFileSync } from "node:fs";
        process.stdin.once("data", () => process.stdout.end(JSON.stringify({
          argv0: process.argv0, score: readFileSync("/proc/self/oom_score_adj", "utf8").trim(),
        })));
      `);
      context.argv0 = "/opt/shims/claude";
      context.env.OPENCLAW_CHILD_OOM_SCORE_ADJ = "1";
      const parentScore = await readFile("/proc/self/oom_score_adj", "utf8");
      using owner = cliProcess.createClaudeCliProcessOwner(() => context);
      const child = await owner.spawn(context);
      let output = "";
      const consumed = child.consumeStdout((chunk) => {
        output += chunk;
      });
      const closed = child.wait();
      try {
        child.stdin?.write("ready");
        child.stdin?.end();
        expect(await closed).toEqual({ code: 0, signal: null });
        await consumed;
        expect(JSON.parse(output)).toEqual({ argv0: context.argv0, score: "1000" });
        expect(await readFile("/proc/self/oom_score_adj", "utf8")).toBe(parentScore);
      } finally {
        child.kill("SIGKILL");
        await closed;
        await consumed;
        await child.waitForExtinction?.();
        child.dispose();
      }
    },
  );

  it("drains pipe-sized stderr and reports a bounded redacted fatal diagnostic", async () => {
    const secret = "sk-ant-api03-synthetic-diagnostic-credential-123456789";
    const context = await contextForChild(`
      import { writeSync } from "node:fs";
      writeSync(2, "discarded noise".repeat(100_000) + "\\n");
      writeSync(2, "Authorization: Bear");
      writeSync(2, "er ${secret}\\n");
      writeSync(2, "PermissionError: [Errno 1] Operation not permitted: '/bin/ps' 🦞");
      process.exit(1);
    `);
    const error = await collect(context).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Claude Code process exited with code 1");
    expect(formatErrorMessageForDisplay(error)).toContain("exited with code 1");
    expect(formatErrorMessageForDisplay(error)).toContain("PermissionError: [Errno 1]");
    expect(formatErrorMessageForDisplay(error)).toContain("'/bin/ps' 🦞");
    expect(formatErrorMessageForDisplay(error)).not.toContain(secret);
    expect(formatErrorMessageForDisplay(error)).not.toContain("discarded noise");
    expect(formatErrorMessageForDisplay(error).length).toBeLessThan(2_200);
  });

  it.skipIf(process.platform === "win32")(
    "preserves a live child's broken pipe when shutdown makes it exit nonzero",
    async () => {
      const context = await contextForChild(`
      import { closeSync } from "node:fs";
      process.on("SIGTERM", () => process.exit(23));
      setInterval(() => {}, 1000);
      closeSync(0);
    `);
      context.systemPrompt = "x".repeat(1024 * 1024);
      await expect(collect(context)).rejects.toMatchObject({ code: "EPIPE" });
    },
  );

  it.skipIf(process.platform === "win32").each([0, 1])(
    "preserves natural exit %i and diagnostics when initialization hits a broken pipe",
    async (exitCode) => {
      const context = await contextForChild(`
        import { writeSync } from "node:fs";
        writeSync(2, "PermissionError: fixture input closed " + process.env.OPENCLAW_MCP_TOKEN + "\\n");
        process.exit(${exitCode});
      `);
      context.env.OPENCLAW_MCP_TOKEN = "opaque-early-exit-fixture";
      // Exceed the pipe buffer so the ignored initialization cannot finish writing.
      context.systemPrompt = "x".repeat(1024 * 1024);
      const error = await collect(context).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        exitCode === 0
          ? "Claude CLI live session exited unexpectedly without a terminal result."
          : "Claude Code process exited with code 1",
      );
      const display = formatErrorMessageForDisplay(error);
      expect(display).toContain("PermissionError: fixture input closed [REDACTED]");
      expect(display).not.toContain(context.env.OPENCLAW_MCP_TOKEN);
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves cancellation while settling a broken input pipe",
    async ({ signal }) => {
      const controller = new AbortController();
      const reason = new Error("Synthetic cancellation after stdin failure.");
      const inputErrors: unknown[] = [];
      observeChild((child) => {
        child.onError((error, source) => {
          if (source !== "stdin") {
            return;
          }
          inputErrors.push(error);
          controller.abort(reason);
        });
      });
      const context = await contextForChild(`
      import { closeSync } from "node:fs";
      setInterval(() => {}, 1000);
      closeSync(0);
    `);
      context.systemPrompt = "x".repeat(1024 * 1024);
      context.abortSignal = AbortSignal.any([controller.signal, context.abortSignal ?? signal]);
      await expect(collect(context)).rejects.toBe(reason);
      expect(inputErrors).toMatchObject([{ code: "EPIPE" }]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "preserves cancellation while broken-pipe diagnostics are draining",
    async ({ signal }) => {
      const controller = new AbortController();
      const reason = new Error("Synthetic cancellation during stderr drainage.");
      const diagnosticsStarted = createDeferred<void>();
      const releaseDiagnostics = createDeferred<void>();
      const inputErrors: unknown[] = [];
      observeChild((child, owner) => {
        child.onError((error, source) => {
          if (source === "stdin") {
            inputErrors.push(error);
          }
        });
        const withDiagnostics = owner.withDiagnostics.bind(owner);
        vi.spyOn(owner, "withDiagnostics").mockImplementation(async (error) => {
          diagnosticsStarted.resolve();
          await withinTest(releaseDiagnostics.promise, signal);
          return withDiagnostics(error);
        });
      });
      const context = await contextForChild("process.exit(1);");
      context.systemPrompt = "x".repeat(1024 * 1024);
      context.abortSignal = AbortSignal.any([controller.signal, context.abortSignal ?? signal]);
      const result = collect(context);
      void result.catch(() => {});
      try {
        await withinTest(diagnosticsStarted.promise, signal);
        expect(inputErrors).toMatchObject([{ code: "EPIPE" }]);
        controller.abort(reason);
        releaseDiagnostics.resolve();
        await expect(result).rejects.toBe(reason);
      } finally {
        releaseDiagnostics.resolve();
        await result.catch(() => {});
      }
    },
  );

  it.skipIf(process.platform === "win32").each([false, true])(
    "shares one failure across late sends and terminal notifications (diagnostics reject: %s)",
    async (diagnosticsReject) => {
      const context = await contextForChild('process.stdin.once("data", () => process.exit(1));');
      const onError = vi.fn();
      const diagnosticError = new Error("Synthetic diagnostic collection failure.");
      let lateSend: Promise<void> | undefined;
      observeChild((child, owner) => {
        if (diagnosticsReject) {
          vi.spyOn(owner, "withDiagnostics").mockRejectedValue(diagnosticError);
        }
        child.onError((_error, source) => {
          if (source !== "stdin") {
            return;
          }
          lateSend = transport.send({ type: "control_response" });
          void lateSend.catch(() => {});
        });
      });
      const transport = await createClaudeCliTransport({
        context,
        args: [...context.args],
        initialize: { appendSystemPrompt: "x".repeat(1024 * 1024) },
        currentContext: () => context,
        onMessage: async () => {},
        onRequest: async () => () => ({}),
        onError,
      });
      try {
        const error = await transport.initialize().catch((failure: unknown) => failure);
        await transport.waitForExit();
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
          diagnosticsReject ? diagnosticError.message : "Claude Code process exited with code 1",
        );
        if (!lateSend) {
          throw new Error("Expected a send after the native stdin error.");
        }
        await expect(lateSend).rejects.toBe(error);
        expect(onError).toHaveBeenCalledExactlyOnceWith(error);
      } finally {
        transport.close();
        await transport.waitForExit();
      }
    },
  );

  it.skipIf(process.platform === "win32").for(["pipe failure", "explicit close"] as const)(
    "aborts pending control requests before disposal and exit on %s",
    async (shutdown, { signal: testSignal }) => {
      const context = await contextForChild(`
      import { closeSync } from "node:fs";
      process.on("SIGTERM", () => process.exit(23));
      setInterval(() => {}, 1000);
      closeSync(0);
      process.stdout.write(JSON.stringify({ type: "control_request", request_id: "pending", request: { subtype: "fixture" } }) + "\\n");
    `);
      const started = createDeferred<AbortSignal>();
      const aborted = createDeferred<boolean>();
      let childExited = false;
      let disposed = false;
      observeChild((child, owner) => {
        const dispose = owner[Symbol.dispose].bind(owner);
        vi.spyOn(owner, Symbol.dispose).mockImplementation(() => {
          disposed = true;
          dispose();
        });
        child.onExit(() => {
          childExited = true;
        });
      });
      const transport = await createClaudeCliTransport({
        context,
        args: [...context.args],
        initialize: {},
        currentContext: () => context,
        onMessage: async () => {},
        onRequest: async (_request, signal) => {
          started.resolve(signal);
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                aborted.resolve(disposed);
                resolve();
              },
              { once: true },
            );
          });
          return () => ({});
        },
        onError: () => {},
      });
      try {
        const signal = await withinTest(started.promise, testSignal);
        let send: Promise<void> | undefined;
        if (shutdown === "pipe failure") {
          send = transport.send({ type: "user", data: "x".repeat(1024 * 1024) });
          void send.catch(() => {});
        } else {
          transport.close();
        }
        expect(await withinTest(aborted.promise, testSignal)).toBe(false);
        expect(signal.aborted).toBe(true);
        expect(childExited).toBe(false);
        if (send) {
          // The relay may accept the initial write before its downstream pipe fails.
          await send.catch((error: unknown) => {
            expect(error).toMatchObject({ code: "EPIPE" });
          });
          await expect(
            transport.send({ type: "user", data: "after pipe failure" }),
          ).rejects.toMatchObject({
            code: "EPIPE",
          });
        }
      } finally {
        transport.close();
        await transport.waitForExit();
      }
    },
  );

  it("masks opaque descriptor and environment credentials without copying native stdout", async () => {
    const context = await contextForChild(`
      import { readFileSync, writeSync } from "node:fs";
      writeSync(1, "native stdout must stay private\\n");
      writeSync(2, "credential: " + readFileSync(3, "utf8") + "\\n");
      writeSync(2, "environment: " + process.env.OPENCLAW_MCP_TOKEN + "\\n");
      writeSync(2, "PermissionError: denied resource 3\\n");
      process.exit(1);
    `);
    const credential = "opaque-descriptor-fixture-value";
    const grant = "opaque-mcp-fixture-value";
    context.env.OPENCLAW_MCP_TOKEN = grant;
    context.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR = "3";
    const buffers: Buffer[] = [];
    const running = collect(context, {
      fd: 3,
      createData: () => {
        const bytes = Buffer.from(credential);
        buffers.push(bytes);
        return bytes;
      },
    });
    const error = await running.catch((failure: unknown) => failure);
    expect(formatErrorMessageForDisplay(error)).toContain("PermissionError: denied resource 3");
    expect(formatErrorMessageForDisplay(error)).toContain("[REDACTED]");
    for (const privateText of [
      credential,
      grant,
      "native stdout must stay private",
      context.prompt,
    ]) {
      expect(formatErrorMessageForDisplay(error)).not.toContain(privateText);
    }
    expect(buffers.length).toBeGreaterThan(0);
    expect(buffers.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
  });

  // POSIX process groups survive root exit; Windows cannot enumerate a spontaneously exited root.
  it.skipIf(process.platform === "win32")(
    "reports failure and reaps a descendant that inherited stderr",
    async ({ signal }) => {
      const context = await contextForChild(`
      import { spawn } from "node:child_process";
      import { writeFileSync, writeSync } from "node:fs";
      // Natural expiry would hide a missing transport tree kill from the exit assertion.
      const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"],
        { stdio: ["ignore", "ignore", 2] });
      writeFileSync("descendant.pid", String(descendant.pid));
      writeSync(2, "PermissionError: parent exited\\n");
      process.exit(1);
    `);
      try {
        const error = await withinTest(
          collect(context).catch((failure: unknown) => failure),
          signal,
        );
        expect(formatErrorMessageForDisplay(error)).toContain("PermissionError: parent exited");
        const pid = Number(await readFile(path.join(context.cwd, "descendant.pid"), "utf8"));
        await waitForDescendantExit(pid, signal);
      } finally {
        const pid = Number(await readFile(path.join(context.cwd, "descendant.pid"), "utf8"));
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    },
  );

  it("keeps diagnostics isolated between live processes", async () => {
    const warm = await contextForChild(PROTOCOL_CHILD);
    attachLiveSession(warm);
    await collect({ ...warm, prompt: "success with stderr" });
    const other = await contextForChild("process.exit(1);");
    attachLiveSession(other);
    await expect(collect(other)).rejects.toThrow(/^Claude Code process exited with code 1$/);
    const error = await collect({ ...warm, prompt: "fail silently" }).catch(
      (failure: unknown) => failure,
    );
    expect(formatErrorMessageForDisplay(error)).toContain(
      "stderr (process-wide; may include earlier turns): previous turn diagnostic",
    );
  });

  it.each([
    { firstPrompt: "success with stderr", prompt: "fail noisily" },
    { firstPrompt: "success with stderr", prompt: "close idle" },
    { firstPrompt: "success with delayed stderr", prompt: "fail silently" },
    { firstPrompt: "success with stderr", prompt: "exit without result" },
  ])(
    "retains process diagnostics after credential cleanup: $firstPrompt then $prompt",
    async ({ firstPrompt, prompt }) => {
      const context = await contextForChild(PROTOCOL_CHILD);
      const credential = "opaque-warm-credential-fixture";
      const processGrant = "opaque-first-process-grant-fixture";
      const backend = buildAnthropicCliBackend();
      const prepare = async () => {
        // The descriptor is a provider-private field, outside the public SDK result type.
        const prepared = (await backend.prepareExecution?.({
          workspaceDir: context.cwd,
          provider: "claude-cli",
          modelId: context.modelId,
          executionMode: "agent",
          authCredential: { type: "token", token: credential },
        } as Parameters<NonNullable<typeof backend.prepareExecution>>[0])) as
          | (CliBackendPreparedExecution & { secretInput?: ClaudeCliSecretInput })
          | undefined;
        if (!prepared?.execute || !prepared.secretInput || !prepared.cleanup) {
          throw new Error("Expected a managed Claude CLI execution.");
        }
        return {
          ...prepared,
          execute: prepared.execute,
          secretInput: prepared.secretInput,
          cleanup: prepared.cleanup,
        };
      };
      const current = attachLiveSession(context);
      const stderr = vi.spyOn(process.stderr, "write");
      const first = await prepare();
      const buffers: Buffer[] = [];
      const createData = first.secretInput.createData;
      vi.spyOn(first.secretInput, "createData").mockImplementation(() => {
        const bytes = createData();
        buffers.push(bytes);
        return bytes;
      });
      await expect(
        collect(
          {
            ...context,
            env: { ...context.env, ...first.env, OPENCLAW_MCP_TOKEN: processGrant },
            prompt: firstPrompt,
          },
          undefined,
          first.execute,
        ),
      ).resolves.toContainEqual(expect.objectContaining({ result: "ok" }));
      await first.cleanup();
      expect(() => first.secretInput.createData()).toThrow("no longer available");
      expect(current()?.isIdle()).toBe(true);
      if (prompt === "close idle") {
        const closing = current();
        closing?.close("idle");
        await closing?.waitForExit();
      } else {
        const second = await prepare();
        const error = await collect(
          {
            ...context,
            env: { ...context.env, ...second.env, OPENCLAW_MCP_TOKEN: "opaque-next-grant-fixture" },
            prompt,
            useResume: true,
          },
          undefined,
          second.execute,
        ).catch((failure: unknown) => failure);
        await second.cleanup();
        expect(formatErrorMessageForDisplay(error)).toContain(
          prompt === "exit without result"
            ? "live session exited unexpectedly"
            : "exited with code 1",
        );
        expect(formatErrorMessageForDisplay(error)).toContain(
          "stderr (process-wide; may include earlier turns):",
        );
        expect(formatErrorMessageForDisplay(error)).toContain("previous turn diagnostic");
        expect(formatErrorMessageForDisplay(error)).not.toContain(credential);
        expect(formatErrorMessageForDisplay(error)).not.toContain(processGrant);
        expect(
          formatErrorMessageForDisplay(error).includes("PermissionError: current turn failed"),
        ).toBe(prompt === "fail noisily" || prompt === "exit without result");
      }
      expect(buffers.length).toBeGreaterThan(0);
      expect(buffers.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
      expect(stderr).not.toHaveBeenCalled();
    },
  );
});

async function discoverFromNativeMenu(models: unknown[]) {
  const context = await contextForChild(`
    import { createInterface } from "node:readline";
    createInterface({ input: process.stdin }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.type !== "control_request" || message.request.subtype !== "initialize") {
        process.exit(7);
      }
      process.stdout.write(JSON.stringify({ type: "control_response", response: {
        subtype: "success", request_id: message.request_id,
        response: { models: ${JSON.stringify(models)} },
      } }) + "\\n");
    });
  `);
  const createOwner = cliProcess.createClaudeCliProcessOwner;
  vi.spyOn(cliProcess, "createClaudeCliProcessOwner").mockImplementation((...args) => {
    const owner = createOwner(...args);
    const spawn = owner.spawn;
    vi.spyOn(owner, "spawn").mockImplementation((options) => {
      expect(options.args).not.toContain("--model");
      expect(options.args).toContain("--tools");
      return spawn({ ...options, command: context.command, args: context.args });
    });
    return owner;
  });
  return discoverClaudeCliModels({ env: context.env });
}

it("discovers deduplicated native model IDs through initialize without a turn", async () => {
  expect(
    await discoverFromNativeMenu([
      {
        value: "default",
        resolvedModel: "claude-future[1m]",
        displayName: "Default (recommended)",
        supportedEffortLevels: ["low", "max"],
      },
      {
        value: "future",
        resolvedModel: "claude-future[1m]",
        displayName: "Future",
        supportedEffortLevels: ["low", "max"],
      },
      {
        value: "opus",
        resolvedModel: "claude-opus-5-5",
        displayName: "Opus",
        supportedEffortLevels: ["low", "max"],
      },
    ]),
  ).toEqual([
    expect.objectContaining({
      id: "claude-future[1m]",
      name: "Future",
      thinkingLevelMap: {
        off: "off",
        minimal: null,
        low: "low",
        medium: null,
        high: null,
        xhigh: null,
        max: "max",
      },
    }),
    expect.objectContaining({
      id: "claude-opus-5-5",
      name: "Opus",
      thinkingLevelMap: expect.objectContaining({ off: null, low: "low", max: "max" }),
    }),
  ]);
});

it("keeps the default label when no explicit option names its model", async () => {
  expect(
    await discoverFromNativeMenu([
      { value: "default", resolvedModel: "claude-hidden", displayName: "Default (recommended)" },
      { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus" },
    ]),
  ).toEqual([
    expect.objectContaining({ id: "claude-hidden", name: "Default (recommended)" }),
    expect.objectContaining({ id: "claude-opus-5-5", name: "Opus" }),
  ]);
});

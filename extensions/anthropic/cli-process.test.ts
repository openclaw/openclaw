import { access, readFile } from "node:fs/promises";
import path from "node:path";
import type { CliBackendExecuteContext } from "openclaw/plugin-sdk/cli-backend";
import { formatErrorMessageForDisplay } from "openclaw/plugin-sdk/error-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OwnedStdioProcess } from "openclaw/plugin-sdk/process-runtime";
import { withinTest } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverClaudeCliModels } from "./cli-model-discovery.js";
import * as cliProcess from "./cli-process.js";
import {
  collectClaudeCli as collect,
  createCliTestHarness,
  prepareClaudeCli,
  recordCredentialBuffers,
  waitForProcessExit,
} from "./cli-runtime.test-support.js";
import { createClaudeCliTransport } from "./cli-transport.js";
import { executeClaudeCli } from "./cli.runtime.js";

const harness = createCliTestHarness();
const LARGE_INPUT = "x".repeat(1024 * 1024);
const EXIT_FAILURE = "Claude Code process exited with code 1";
const CLOSED_INPUT_CHILD = `
  import { closeSync } from "node:fs";
  process.on("SIGTERM", () => process.exit(23));
  setInterval(() => {}, 1000);
  closeSync(0);
`;
const PROTOCOL_SETUP = String.raw`
  import { createInterface } from "node:readline";
  const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
`;

const PROTOCOL_CHILD = `
  ${PROTOCOL_SETUP}
  import { readFileSync, writeSync } from "node:fs";
  const credential = process.env.CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR
    ? readFileSync(3, "utf8") : "";
  let delayedDiagnostic = "";
  createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line);
    if (message.type === "control_request") {
      send({ type: "control_response", response: {
        subtype: "success", request_id: message.request_id, response: {},
      } });
    } else if (message.type === "user") {
      const text = message.message.content;
      writeSync(1, "native stdout must stay private\\n");
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
      send({ type: "result", subtype: "success", is_error: false, result: "ok" });
    }
  });
`;

const STARTUP_HOOK_CHILD = String.raw`
  ${PROTOCOL_SETUP}
  import { writeFileSync } from "node:fs";
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
  await harness.cleanup();
  vi.restoreAllMocks();
});

const contextForChild = (source: string, signal?: AbortSignal) =>
  harness.context(source, signal ? { abortSignal: signal } : {});

const failureOf = (running: Promise<unknown>) => running.catch((failure: unknown) => failure);

function expectDiagnostic(error: unknown, included: string[], excluded: string[] = []) {
  const display = formatErrorMessageForDisplay(error);
  for (const text of included) {
    expect(display).toContain(text);
  }
  for (const text of excluded) {
    expect(display).not.toContain(text);
  }
  return display;
}

async function transportFor(
  context: CliBackendExecuteContext,
  options: Partial<Parameters<typeof createClaudeCliTransport>[0]> = {},
) {
  const transport = await createClaudeCliTransport({
    context,
    args: [...context.args],
    initialize: {},
    currentContext: () => context,
    onMessage: async () => {},
    onRequest: async () => () => ({}),
    onError: () => {},
    ...options,
  });
  return {
    ...transport,
    [Symbol.asyncDispose]: async () => {
      transport.close();
      await transport.waitForExit();
    },
  };
}

function interceptSpawn(
  intercept: (
    owner: ReturnType<typeof cliProcess.createClaudeCliProcessOwner>,
    spawn: ReturnType<typeof cliProcess.createClaudeCliProcessOwner>["spawn"],
  ) => ReturnType<typeof cliProcess.createClaudeCliProcessOwner>["spawn"],
) {
  const createOwner = cliProcess.createClaudeCliProcessOwner;
  vi.spyOn(cliProcess, "createClaudeCliProcessOwner").mockImplementation((...args) => {
    const owner = createOwner(...args);
    const spawn = owner.spawn;
    vi.spyOn(owner, "spawn").mockImplementation(intercept(owner, spawn));
    return owner;
  });
}

function observeChild(
  observe: (
    child: OwnedStdioProcess,
    owner: ReturnType<typeof cliProcess.createClaudeCliProcessOwner>,
  ) => void | Promise<void>,
) {
  interceptSpawn((owner, spawn) => async (options) => {
    const child = await spawn(options);
    await observe(child, owner);
    return child;
  });
}

function attachLiveSession(context: CliBackendExecuteContext) {
  const liveSession = harness.liveSession();
  context.liveSession = liveSession;
  return () => liveSession.current();
}

describe("Claude subprocess diagnostics through the direct CLI transport", () => {
  it("orders startup hooks before first and warm turns", async ({ signal }) => {
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
    "cancels startup before accepting input: %s",
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

  it("joins startup and child extinction on close during spawn", async ({ signal }) => {
    const context = await contextForChild(PROTOCOL_CHILD);
    const current = attachLiveSession(context);
    const spawned = createDeferred<void>();
    const release = createDeferred<void>();
    const extinct = vi.fn();
    observeChild(async (child) => {
      void child.waitForExtinction?.().then(extinct, () => {});
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
      const finished = vi.fn();
      waiting = session.waitForExit().then(finished);
      void waiting.catch(() => {});
      // Let a prematurely resolved exit promise run before releasing startup.
      await Promise.resolve();
      expect(finished).not.toHaveBeenCalled();
      release.resolve();
      await withinTest(waiting, signal);
      expect(extinct).toHaveBeenCalled();
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
    "isolates the child OOM score and preserves shim identity",
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
    const error = await failureOf(collect(context));
    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty("message", EXIT_FAILURE);
    const display = expectDiagnostic(
      error,
      ["exited with code 1", "PermissionError: [Errno 1]", "'/bin/ps' 🦞"],
      [secret, "discarded noise"],
    );
    expect(display.length).toBeLessThan(2_200);
  });

  it.skipIf(process.platform === "win32")(
    "preserves EPIPE when forced shutdown exits nonzero",
    async () => {
      const context = await contextForChild(CLOSED_INPUT_CHILD);
      context.systemPrompt = LARGE_INPUT;
      await expect(collect(context)).rejects.toMatchObject({ code: "EPIPE" });
    },
  );

  it.skipIf(process.platform === "win32").each([0, 1])(
    "preserves natural exit %i and diagnostics after EPIPE",
    async (exitCode) => {
      const context = await contextForChild(`
        import { writeSync } from "node:fs";
        writeSync(2, "PermissionError: fixture input closed " + process.env.OPENCLAW_MCP_TOKEN + "\\n");
        process.exit(${exitCode});
      `);
      context.env.OPENCLAW_MCP_TOKEN = "opaque-early-exit-fixture";
      // Exceed the pipe buffer so the ignored initialization cannot finish writing.
      context.systemPrompt = LARGE_INPUT;
      const error = await failureOf(collect(context));
      expect(error).toBeInstanceOf(Error);
      expect(error).toHaveProperty(
        "message",
        exitCode === 0
          ? "Claude CLI live session exited unexpectedly without a terminal result."
          : EXIT_FAILURE,
      );
      expectDiagnostic(
        error,
        ["PermissionError: fixture input closed [REDACTED]"],
        [context.env.OPENCLAW_MCP_TOKEN],
      );
    },
  );

  it.skipIf(process.platform === "win32").for(["input failure", "diagnostic drainage"] as const)(
    "preserves cancellation during %s",
    async (stage, { signal }) => {
      const controller = new AbortController();
      const reason = new Error(`Synthetic cancellation during ${stage}.`);
      const diagnosticsStarted = createDeferred<void>();
      const releaseDiagnostics = createDeferred<void>();
      const inputErrors: unknown[] = [];
      observeChild((child, owner) => {
        child.onError((error, source) => {
          if (source === "stdin") {
            inputErrors.push(error);
            if (stage === "input failure") {
              controller.abort(reason);
            }
          }
        });
        if (stage === "diagnostic drainage") {
          const withDiagnostics = owner.withDiagnostics.bind(owner);
          vi.spyOn(owner, "withDiagnostics").mockImplementation(async (error) => {
            diagnosticsStarted.resolve();
            await withinTest(releaseDiagnostics.promise, signal);
            return withDiagnostics(error);
          });
        }
      });
      const context = await contextForChild(
        stage === "diagnostic drainage"
          ? "process.exit(1);"
          : `
      import { closeSync } from "node:fs";
      setInterval(() => {}, 1000);
      closeSync(0);
    `,
      );
      context.systemPrompt = LARGE_INPUT;
      context.abortSignal = AbortSignal.any([controller.signal, context.abortSignal ?? signal]);
      const result = collect(context);
      void result.catch(() => {});
      try {
        if (stage === "diagnostic drainage") {
          await withinTest(diagnosticsStarted.promise, signal);
          expect(inputErrors).toMatchObject([{ code: "EPIPE" }]);
          controller.abort(reason);
          releaseDiagnostics.resolve();
        }
        await expect(result).rejects.toBe(reason);
        expect(inputErrors).toMatchObject([{ code: "EPIPE" }]);
      } finally {
        releaseDiagnostics.resolve();
        await result.catch(() => {});
      }
    },
  );

  it.skipIf(process.platform === "win32").each([false, true])(
    "shares send/terminal failure (diagnostics reject: %s)",
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
      await using transport = await transportFor(context, {
        initialize: { appendSystemPrompt: LARGE_INPUT },
        onError,
      });
      const error = await failureOf(transport.initialize());
      await transport.waitForExit();
      expect(error).toBeInstanceOf(Error);
      expect(error).toHaveProperty(
        "message",
        diagnosticsReject ? diagnosticError.message : EXIT_FAILURE,
      );
      if (!lateSend) {
        throw new Error("Expected a send after the native stdin error.");
      }
      await expect(lateSend).rejects.toBe(error);
      expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    },
  );

  it.skipIf(process.platform === "win32").for(["pipe failure", "explicit close"] as const)(
    "aborts requests before disposal/exit on %s",
    async (shutdown, { signal: testSignal }) => {
      const context = await contextForChild(`${CLOSED_INPUT_CHILD}
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
      await using transport = await transportFor(context, {
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
      });
      const signal = await withinTest(started.promise, testSignal);
      let send: Promise<void> | undefined;
      if (shutdown === "pipe failure") {
        send = transport.send({ type: "user", data: LARGE_INPUT });
        void send.catch(() => {});
      } else {
        transport.close();
      }
      expect({
        disposedAtAbort: await withinTest(aborted.promise, testSignal),
        aborted: signal.aborted,
        childExited,
      }).toEqual({ disposedAtAbort: false, aborted: true, childExited: false });
      if (send) {
        // The relay may accept the initial write before its downstream pipe fails.
        await send.catch((error: unknown) => {
          expect(error).toMatchObject({ code: "EPIPE" });
        });
        await expect(
          transport.send({ type: "user", data: "after pipe failure" }),
        ).rejects.toMatchObject({ code: "EPIPE" });
      }
    },
  );

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
        const error = await withinTest(failureOf(collect(context)), signal);
        expectDiagnostic(error, ["PermissionError: parent exited"]);
        const pid = Number(await readFile(path.join(context.cwd, "descendant.pid"), "utf8"));
        await waitForProcessExit([pid], signal);
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
    const error = await failureOf(collect({ ...warm, prompt: "fail silently" }));
    expectDiagnostic(error, [
      "stderr (process-wide; may include earlier turns): previous turn diagnostic",
    ]);
  });

  it.each([
    { firstPrompt: "success with stderr", prompt: "fail noisily" },
    { firstPrompt: "success with stderr", prompt: "close idle" },
    { firstPrompt: "success with delayed stderr", prompt: "fail silently" },
    { firstPrompt: "success with stderr", prompt: "exit without result" },
  ])(
    "retains diagnostics after credential cleanup: $firstPrompt then $prompt",
    async ({ firstPrompt, prompt }) => {
      const context = await contextForChild(PROTOCOL_CHILD);
      const credential = "opaque-warm-credential-fixture";
      const processGrant = "opaque-first-process-grant-fixture";
      const prepare = () => prepareClaudeCli(context, { type: "token", token: credential });
      const current = attachLiveSession(context);
      const stderr = vi.spyOn(process.stderr, "write");
      const first = await prepare();
      const buffers = recordCredentialBuffers(first.secretInput);
      const runPrepared = (
        prepared: typeof first,
        input: string,
        grant: string,
        useResume = false,
      ) =>
        collect(
          {
            ...context,
            env: { ...context.env, ...prepared.env, OPENCLAW_MCP_TOKEN: grant },
            prompt: input,
            useResume,
          },
          undefined,
          prepared.execute,
        );
      await expect(runPrepared(first, firstPrompt, processGrant)).resolves.toContainEqual(
        expect.objectContaining({ result: "ok" }),
      );
      await first.cleanup();
      expect(() => first.secretInput.createData()).toThrow("no longer available");
      expect(current()?.isIdle()).toBe(true);
      if (prompt === "close idle") {
        const closing = current();
        closing?.close("idle");
        await closing?.waitForExit();
      } else {
        const second = await prepare();
        const error = await failureOf(
          runPrepared(second, prompt, "opaque-next-grant-fixture", true),
        );
        await second.cleanup();
        const display = expectDiagnostic(
          error,
          [
            prompt === "exit without result"
              ? "live session exited unexpectedly"
              : "exited with code 1",
            "stderr (process-wide; may include earlier turns):",
            "previous turn diagnostic",
            "[REDACTED]",
          ],
          [credential, processGrant, "native stdout must stay private", context.prompt],
        );
        expect(display.includes("PermissionError: current turn failed")).toBe(
          prompt === "fail noisily" || prompt === "exit without result",
        );
      }
      expect(buffers.length).toBeGreaterThan(0);
      expect(buffers.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
      expect(stderr).not.toHaveBeenCalled();
    },
  );
});

async function discoverFromNativeMenu(models: unknown[]) {
  const context = await contextForChild(`
    ${PROTOCOL_SETUP}
    createInterface({ input: process.stdin }).on("line", (line) => {
      const message = JSON.parse(line);
      if (message.type !== "control_request" || message.request.subtype !== "initialize") {
        process.exit(7);
      }
      send({ type: "control_response", response: {
        subtype: "success", request_id: message.request_id,
        response: { models: ${JSON.stringify(models)} },
      } });
    });
  `);
  interceptSpawn((_owner, spawn) => (options) => {
    expect(options.args).not.toContain("--model");
    expect(options.args).toContain("--tools");
    return spawn({ ...options, command: context.command, args: context.args });
  });
  return discoverClaudeCliModels({ env: context.env });
}

it("discovers native models without a turn, resolving aliases and retaining unmatched defaults", async () => {
  expect(
    await discoverFromNativeMenu([
      ...[
        ["default", "claude-future[1m]", "Default (recommended)"],
        ["future", "claude-future[1m]", "Future"],
        ["opus", "claude-opus-5-5", "Opus"],
      ].map(([value, resolvedModel, displayName]) => ({
        value,
        resolvedModel,
        displayName,
        supportedEffortLevels: ["low", "max"],
      })),
      { value: "default", resolvedModel: "claude-hidden", displayName: "Default (recommended)" },
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
    expect.objectContaining({ id: "claude-hidden", name: "Default (recommended)" }),
  ]);
});

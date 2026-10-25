import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { assert, expect, it, vi } from "vitest";
import { createAutoReviewTool } from "./tool.js";

// mock-isolation: Exercise tool admission without starting host child processes.
vi.mock("openclaw/plugin-sdk/process-runtime", () => ({
  runCommandWithTimeout: vi.fn(),
}));

type Command = typeof runCommandWithTimeout;
type CommandOptions = Exclude<Parameters<Command>[1], number>;
function json(data: unknown, code = 0, stderr = "") {
  return { code, stdout: JSON.stringify(data), stderr };
}
function rejectOnAbort(signal: AbortSignal | undefined, error: Error) {
  return new Promise<never>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(error), { once: true });
  });
}
const params = { mode: "local" as const };
const prompt = "Review the frozen shipping change.";
const report = { findings: [{ title: "[P2] Finding" }], verdict: "request_changes" };
const reportDetails = (model: string) => ({
  report,
  status: { report_produced: true, effective_models: [model] },
});
const toolPolicy = (provider: string, allow: string[] = [], alsoAllow: string[] = []) => ({
  allow,
  alsoAllow,
  byProvider: { [provider]: { allow, alsoAllow } },
  sandbox: { tools: { allow, alsoAllow } },
});
const scope = (signal: AbortSignal, model = "fixture/preferred") => ({
  model,
  agentId: "caller",
  signal,
  assertCurrent: () => signal.throwIfAborted(),
});
const rootTools = toolPolicy("FIXTURE", ["exec"], ["process"]);
const callerTools = {
  ...toolPolicy("Fixture/Preferred", ["write"], ["autoreview"]),
  codeMode: { enabled: true },
};

function fixture(
  overrides: {
    result?: Partial<Awaited<ReturnType<Command>>>;
    helperFailure?: string;
    request?: Record<string, unknown>;
    next?: Record<string, unknown>;
  } = {},
) {
  const request = {
    protocol: "autoreview-exec-v1",
    run_id: "fixture-run",
    pass: 1,
    passes: 1,
    prompt,
    prompt_bytes: Buffer.byteLength(prompt),
    prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
    model: "fixture/preferred",
    thinking: null,
    max_result_bytes: 2_000_000,
    admitted_model: true,
    engine_timeout_seconds: null,
    ...overrides.request,
  };
  const helper = Promise.withResolvers<ReturnType<typeof json>>();
  let response:
    | { pass: number; status: string; output: string | null; model: string | null }
    | undefined;
  let cwd: string | undefined;
  let helperArgv: readonly string[] | undefined;
  const command = vi
    .mocked(runCommandWithTimeout)
    .mockReset()
    .mockImplementation(async (argv, options) => {
      assert(typeof options !== "number", "expected process options");
      expect(argv.slice(0, 2)).toEqual([process.execPath, "/host/openclaw/openclaw.mjs"]);
      expect(argv).not.toContain("--config");
      expect(argv).not.toContain("--isolated");
      expect(options.baseEnv).toBeUndefined();
      expect(options.input).toBe(prompt);
      expect(options).toMatchObject({ killProcessTree: true, killGraceMs: 5_000 });
      cwd = options.cwd;
      expect(await fs.readdir(cwd!)).toEqual([]);
      return {
        stdout: "complete",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
        cleanup: "normal",
        noOutputTimedOut: false,
        ...overrides.result,
      };
    });
  const admitted = vi.fn<(selection: { model: string | null; explicit: boolean }) => void>();
  const context: OpenClawPluginToolContext<2> = {
    assertInvocationCurrent() {},
    assertCompleteResult() {},
    runtimeConfig: { tools: rootTools, agents: { entries: { caller: { tools: callerTools } } } },
    modelExecution: {
      cliEntryPath: "/host/openclaw/openclaw.mjs",
      async run(selection, action, signal) {
        admitted(selection);
        const activeSignal = signal ?? new AbortController().signal;
        const result = await action(scope(activeSignal, selection.model ?? "fixture/default"));
        activeSignal.throwIfAborted();
        return result;
      },
    },
    sandbox: {
      workspaceDir: "/guest/current-repo",
      installedSkillRoots: { autoreview: "/protected/autoreview" },
      async run({ argv, input, signal }) {
        if (argv.includes("--native-handoff")) {
          helperArgv = argv;
          return Promise.race([
            helper.promise,
            rejectOnAbort(signal, new DOMException("Cancelled", "AbortError")),
          ]);
        }
        if (argv.includes("--native-submit")) {
          response = JSON.parse(input!);
          const done = response?.status === "done";
          if (!done || response?.pass === request.passes) {
            const details = overrides.helperFailure
              ? { report: null, status: null }
              : reportDetails(request.model);
            const stderr = overrides.helperFailure ?? (done ? "" : "reviewer unavailable");
            helper.resolve(json({ code: 1, ...details }, done ? 1 : 2, stderr));
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        return json(
          argv.some((arg) => arg.endsWith("/1.request.json"))
            ? request
            : { ...request, pass: 2, ...overrides.next },
        );
      },
    },
  };
  const tool = createAutoReviewTool(context)!;
  return {
    context,
    command,
    admitted,
    execute: (input: Parameters<typeof tool.execute>[1] = params, signal?: AbortSignal) =>
      tool.execute("review", input, signal),
    response: () => response,
    cwd: () => cwd,
    helperArgv: () => helperArgv,
    argv: () => command.mock.calls[0]![0],
  };
}

it("preserves settings, isolation, and complete output", async () => {
  const output = "x".repeat(100000);
  const test = fixture({
    result: { stdout: output },
    request: {
      config_override: {
        models: { providers: { fixture: { localService: { command: "/untrusted/host" } } } },
      },
      agent_override: { skills: ["private-host-skill"] },
    },
  });
  const result = await test.execute();
  const text = JSON.stringify(reportDetails("fixture/preferred"));
  expect(result.content).toEqual([{ type: "text", text }]);
  expect(test.response()).toMatchObject({ status: "done", output, model: "fixture/preferred" });
  for (const flag of ["--model", "--thinking", "--engine-timeout-seconds", "--max-review-passes"]) {
    expect(test.helperArgv()).not.toContain(flag);
  }
  const argv = test.argv();
  expect(argv).toEqual(expect.arrayContaining(["--code-mode", "direct"]));
  for (const flag of ["--model", "--thinking", "--timeout"]) {
    expect(argv).not.toContain(flag);
  }
  const overrides = argv.flatMap((arg, index) =>
    arg === "--config-override" ? [JSON.parse(argv[index + 1]!)] : [],
  );
  const caller = {
    skills: [],
    contextInjection: "never",
    nativeRuntimeConsent: [],
    model: { primary: "fixture/preferred", fallbacks: [] },
    tools: toolPolicy("Fixture/Preferred"),
  };
  expect(overrides).toEqual([
    {
      tools: {
        ...toolPolicy("FIXTURE"),
        deny: ["*"],
        toolSearch: false,
        codeMode: { enabled: false },
      },
      agents: {
        defaults: { systemAgent: { agentId: "caller" } },
        entries: { caller },
      },
    },
  ]);
  expect(test.admitted.mock.calls[0]![0]).toEqual({ model: "fixture/preferred", explicit: false });
  await expect(fs.stat(path.dirname(test.cwd()!))).rejects.toMatchObject({ code: "ENOENT" });
});

it("forwards changed defaults and requested overrides", async () => {
  const test = fixture({ request: { model: "fixture/new-default", thinking: "high" } });
  await test.execute({ ...params, maxPriority: "P2", passes: 12, timeoutSeconds: 900 });
  expect(test.admitted.mock.calls[0]![0]).toEqual({
    model: "fixture/new-default",
    explicit: false,
  });
  for (const pair of [
    ["--max-priority", "P2"],
    ["--max-review-passes", "12"],
    ["--engine-timeout-seconds", "900"],
  ]) {
    expect(test.helperArgv()).toEqual(expect.arrayContaining(pair));
  }
  expect(test.argv()).toEqual(expect.arrayContaining(["--thinking", "high"]));
});

it.each([{ model: "other" }, { passes: 3 }])("rejects plan changes: %j", async (next) => {
  const test = fixture({ request: { passes: 2 }, next });
  await expect(test.execute()).rejects.toThrow("substituted prepared pass");
  expect(test.command).toHaveBeenCalledOnce();
});

it.each([
  [{ admitted_model: undefined }, {}, "update the Auto Review skill"],
  [{ model: "other" }, { model: "preferred" }, "substituted prepared pass"],
  [{}, { passes: 0 }, "Invalid Auto Review arguments"],
  [{}, { timeoutSeconds: 0 }, "Invalid Auto Review arguments"],
  [{}, { openclawBin: "/untrusted" }, "Invalid Auto Review arguments"],
] as const)("rejects request %j / input %j", async (request, input, error) => {
  const test = fixture({ request });
  await expect(test.execute({ ...params, ...input })).rejects.toThrow(error);
  expect(test.command).not.toHaveBeenCalled();
});

it.each([
  [{ code: 1, termination: "exit" }, "exit 1, exit, cleanup normal"],
  [{ code: null, termination: "timeout", killed: true }, "exit none, timeout"],
] as const)("redacts and bounds CLI failure %j", async (result, diagnostic) => {
  const test = fixture({
    result: {
      ...result,
      stderr: `${"x".repeat(5000)}\nAuthorization: Bearer unrelated-fake-secret-token`,
    },
  });
  const failure = await test.execute().catch((error: unknown) => error);
  assert(failure instanceof Error, "Expected reviewer failure");
  expect(failure.message).toContain("reviewer unavailable");
  expect(failure.message).toContain(`Reviewer command failed (${diagnostic}`);
  expect(failure.message).not.toContain("unrelated-fake-secret-token");
  expect(failure.message.length).toBeLessThan(4300);
  expect(test.response()).toMatchObject({ status: "failed", output: null, model: null });
  expect(test.command).toHaveBeenCalledOnce();
});

it("preserves helper diagnostics without a report", async () => {
  const diagnostic = "source changed; rerun autoreview against the updated tree";
  await expect(fixture({ helperFailure: diagnostic }).execute()).rejects.toThrow(diagnostic);
});

it.each(["installation", "authority"])("requires protected %s", (requirement) => {
  const { context } = fixture();
  if (requirement === "installation") {
    context.sandbox!.installedSkillRoots = {};
  } else {
    context.modelExecution = undefined;
  }
  expect(createAutoReviewTool(context)).toBeNull();
});

it.each([null, 900.25])("retains timeout %s across passes", async (timeoutSeconds) => {
  const test = fixture({ request: { passes: 2, engine_timeout_seconds: timeoutSeconds } });
  await test.execute();
  expect(test.command).toHaveBeenCalledTimes(2);
  for (const [argv, options] of test.command.mock.calls) {
    if (timeoutSeconds === null) {
      expect(argv).not.toContain("--timeout");
    } else {
      expect(argv).toEqual(expect.arrayContaining(["--timeout", "901"]));
    }
    expect(options).toMatchObject({ timeoutMs: timeoutSeconds === null ? undefined : 900_250 });
  }
  expect(test.response()).toMatchObject({ pass: 2, status: "done" });
});

it.each(["caller", "model authority"])("cancels after %s revocation", async (owner) => {
  const test = fixture();
  const authority = new AbortController();
  const started = Promise.withResolvers<CommandOptions>();
  const cancellation = new Error("Review cancelled");
  if (owner === "model authority") {
    test.context.modelExecution!.run = async (_selection, action) =>
      await action(scope(authority.signal));
  }
  test.command.mockImplementation(async (_argv, options) => {
    assert(typeof options !== "number", "expected process options");
    started.resolve(options);
    return rejectOnAbort(options.signal, cancellation);
  });
  const result = test.execute(params, owner === "caller" ? authority.signal : undefined);
  const rejected = expect(result).rejects.toThrow("Review cancelled");
  const options = await started.promise;
  authority.abort(cancellation);
  await rejected;
  expect(options.signal?.aborted).toBe(true);
  expect(test.response()).toBeUndefined();
  await expect(fs.stat(path.dirname(options.cwd!))).rejects.toMatchObject({ code: "ENOENT" });
});

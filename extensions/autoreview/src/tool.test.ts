import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { assert, beforeEach, expect, it, vi } from "vitest";
import { commandResult } from "../../test-support/command-result.test-support.js";
import { createAutoReviewTool } from "./tool.js";

// mock-isolation: Exercise tool admission without starting host child processes.
vi.mock("openclaw/plugin-sdk/process-runtime", () => ({ runCommandWithTimeout: vi.fn() }));
type CommandOptions = Exclude<Parameters<typeof runCommandWithTimeout>[1], number>;
type Tool = NonNullable<ReturnType<typeof createAutoReviewTool>>;
const command = vi.mocked(runCommandWithTimeout);
const admitted = vi.fn<(selection: { model: string | null; explicit: boolean }) => void>();
const params = { mode: "local" as const };
const prompt = "Review the frozen shipping change.";
const report = { findings: [{ title: "[P2] Finding" }], verdict: "request_changes" };
const reportDetails = (model: string) => ({ report, status: { effective_models: [model] } });
const toolPolicy = (provider: string, allow: string[] = [], alsoAllow: string[] = []) => {
  const grants = { allow, alsoAllow };
  return { ...grants, byProvider: { [provider]: grants }, sandbox: { tools: grants } };
};
const rootTools = toolPolicy("FIXTURE", ["exec"], ["process"]);
const callerTools = {
  ...toolPolicy("Fixture/Preferred", ["write"], ["autoreview"]),
  codeMode: { enabled: true },
};
function scope(signal: AbortSignal, model = "fixture/preferred") {
  return { model, agentId: "caller", signal, assertCurrent: signal.throwIfAborted.bind(signal) };
}
const baseRequest = {
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
};
let request: typeof baseRequest & Record<string, unknown>;
let next: Record<string, unknown>;
let result: ReturnType<typeof commandResult>;
let helperFailure: string;
type Response = { pass: number; status: string; output: string | null; model: string | null };
let response: Response | undefined;
let cwd: string | undefined;
let helperArgv: readonly string[] | undefined;
let context: OpenClawPluginToolContext<2>;
function json(data: unknown, code = 0, stderr = "") {
  return { code, stdout: JSON.stringify(data), stderr };
}
const abortError = new DOMException("Cancelled", "AbortError");
function rejectOnAbort(signal: AbortSignal | undefined, error: Error = abortError) {
  return new Promise<never>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(error), { once: true });
  });
}
function execute(input: Parameters<Tool["execute"]>[1] = params, signal?: AbortSignal) {
  return createAutoReviewTool(context)!.execute("review", input, signal);
}
beforeEach(() => {
  request = { ...baseRequest };
  next = {};
  result = commandResult({ stdout: "complete", cleanup: "normal" });
  helperFailure = "";
  response = undefined;
  cwd = undefined;
  helperArgv = undefined;
  admitted.mockClear();
  command.mockReset().mockImplementation(async (_argv, options) => {
    assert(typeof options !== "number");
    cwd = options.cwd;
    expect(await fs.readdir(cwd!)).toEqual([]);
    return result;
  });
  const helper = Promise.withResolvers<ReturnType<typeof json>>();
  context = {
    assertInvocationCurrent() {},
    assertCompleteResult() {},
    runtimeConfig: { tools: rootTools, agents: { entries: { caller: { tools: callerTools } } } },
    modelExecution: {
      cliEntryPath: "/host/openclaw/openclaw.mjs",
      async run(selection, action, signal) {
        admitted(selection);
        return action(scope(signal!, selection.model ?? "fixture/default"));
      },
    },
    sandbox: {
      workspaceDir: "/guest/current-repo",
      installedSkillRoots: { autoreview: "/protected/autoreview" },
      async run({ argv, input, signal }) {
        if (argv.includes("--native-handoff")) {
          helperArgv = argv;
          return Promise.race([helper.promise, rejectOnAbort(signal)]);
        }
        if (argv.includes("--native-submit")) {
          response = JSON.parse(input!);
          const done = response?.status === "done";
          if (!done || response?.pass === request.passes) {
            const details = helperFailure ? {} : reportDetails(request.model);
            helper.resolve(json({ code: 1, ...details }, done ? 1 : 2, helperFailure));
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        return json(
          argv.some((arg) => arg.endsWith("/1.request.json"))
            ? request
            : { ...request, pass: 2, ...next },
        );
      },
    },
  };
});

it("preserves settings, isolation, and complete output", async () => {
  const output = "x".repeat(100000);
  result.stdout = output;
  request.config_override = { models: { providers: { x: { localService: { command: "/bad" } } } } };
  request.agent_override = { skills: ["private-host-skill"] };
  const text = JSON.stringify(reportDetails("fixture/preferred"));
  expect((await execute()).content).toEqual([{ type: "text", text }]);
  expect(response).toMatchObject({ status: "done", output, model: "fixture/preferred" });
  const overrides = /^(--model|--thinking|--engine-timeout-seconds|--max-review-passes)$/;
  expect(helperArgv?.filter((arg) => overrides.test(arg))).toEqual([]);
  const [argv, options] = command.mock.calls[0]!;
  expect(argv.slice(0, 10).join(" ")).toBe(
    `${process.execPath} /host/openclaw/openclaw.mjs agent exec --json --code-mode direct --message-file - --config-override`,
  );
  expect(argv.slice(11)).toEqual(["--cwd", cwd]);
  assert(typeof options !== "number");
  expect(options.baseEnv).toBeUndefined();
  expect(options.input).toBe(prompt);
  expect(options).toMatchObject({ killProcessTree: true, killGraceMs: 5_000 });
  const { tools, agents, ...rest } = JSON.parse(argv[10]!);
  expect(rest).toEqual({});
  expect(tools).toEqual({
    ...toolPolicy("FIXTURE"),
    deny: ["*"],
    toolSearch: false,
    codeMode: { enabled: false },
  });
  const caller = {
    skills: [],
    contextInjection: "never",
    nativeRuntimeConsent: [],
    model: { primary: "fixture/preferred", fallbacks: [] },
    tools: toolPolicy("Fixture/Preferred"),
  };
  expect(agents).toEqual({ defaults: { systemAgent: { agentId: "caller" } }, entries: { caller } });
  await expect(fs.stat(path.dirname(cwd!))).rejects.toMatchObject({ code: "ENOENT" });
});

const substituted = "substituted prepared pass";
const invalidArguments = "Invalid Auto Review arguments";
it.each([
  [{ passes: 2 }, { model: "other" }, {}, substituted, 1],
  [{ passes: 2 }, { passes: 3 }, {}, substituted, 1],
  [{ admitted_model: undefined }, {}, {}, "update the Auto Review skill", 0],
  [{ model: "other" }, {}, { model: "preferred" }, substituted, 0],
  [{}, {}, { passes: 0 }, invalidArguments, 0],
  [{}, {}, { timeoutSeconds: 0 }, invalidArguments, 0],
  [{}, {}, { openclawBin: "/untrusted" }, invalidArguments, 0],
] as const)("rejects preparation %j / %j / %j", async (change, following, input, error, calls) => {
  Object.assign(request, change);
  next = following;
  await expect(execute({ ...params, ...input })).rejects.toThrow(error);
  expect(command).toHaveBeenCalledTimes(calls);
});
it.each([
  [{ code: 1, termination: "exit" }, "exit 1, exit, cleanup normal"],
  [{ code: null, termination: "timeout", killed: true }, "exit none, timeout"],
] as const)("redacts and bounds CLI failure %j", async (change, diagnostic) => {
  Object.assign(result, change);
  result.stderr = `${"x".repeat(5000)}\nAuthorization: Bearer unrelated-fake-secret-token`;
  const failure = await execute().catch((error: unknown) => error);
  assert(failure instanceof Error, "Expected reviewer failure");
  expect(failure.message).toContain(`Reviewer command failed (${diagnostic}`);
  expect(failure.message).not.toContain("unrelated-fake-secret-token");
  expect(failure.message.length).toBeLessThan(4300);
  expect(response).toMatchObject({ status: "failed", output: null, model: null });
});
it("preserves helper diagnostics without a report", async () => {
  helperFailure = "source changed; rerun autoreview against the updated tree";
  await expect(execute()).rejects.toThrow(helperFailure);
});
it.each(["installation", "authority"])("requires protected %s", (requirement) => {
  if (requirement === "installation") {
    context.sandbox!.installedSkillRoots = {};
  } else {
    context.modelExecution = undefined;
  }
  expect(createAutoReviewTool(context)).toBeNull();
});
it.each([null, 900.25])("forwards settings with per-pass timeout %s", async (seconds) => {
  const model = "fixture/new-default";
  Object.assign(request, { model, thinking: "high", passes: 2, engine_timeout_seconds: seconds });
  await execute({ ...params, maxPriority: "P2", passes: 12, timeoutSeconds: 900 });
  expect(admitted.mock.calls[0]![0]).toEqual({ model, explicit: false });
  expect(helperArgv).toEqual(expect.arrayContaining(["--max-priority", "P2"]));
  expect(helperArgv).toEqual(expect.arrayContaining(["--max-review-passes", "12"]));
  expect(helperArgv).toEqual(expect.arrayContaining(["--engine-timeout-seconds", "900"]));
  expect(command).toHaveBeenCalledTimes(2);
  for (const [argv, options] of command.mock.calls) {
    expect(argv).toEqual(expect.arrayContaining(["--thinking", "high"]));
    const timeoutArgs = argv.filter((arg, i) => arg === "--timeout" || argv[i - 1] === "--timeout");
    expect(timeoutArgs).toEqual(seconds === null ? [] : ["--timeout", "901"]);
    expect(options).toMatchObject({ timeoutMs: seconds === null ? undefined : 900_250 });
  }
  expect(response).toMatchObject({ pass: 2, status: "done" });
});
it.each(["caller", "model authority"])("cancels after %s revocation", async (owner) => {
  const authority = new AbortController();
  const started = Promise.withResolvers<CommandOptions>();
  const cancellation = new Error("Review cancelled");
  if (owner === "model authority") {
    context.modelExecution!.run = async (_selection, action) => action(scope(authority.signal));
  }
  command.mockImplementation(async (_argv, options) => {
    assert(typeof options !== "number");
    started.resolve(options);
    return rejectOnAbort(options.signal, cancellation);
  });
  const signal = owner === "caller" ? authority.signal : undefined;
  const rejected = expect(execute(params, signal)).rejects.toThrow(cancellation);
  const options = await started.promise;
  authority.abort(cancellation);
  await rejected;
  expect(options.signal?.aborted).toBe(true);
  expect(response).toBeUndefined();
  await expect(fs.stat(path.dirname(options.cwd!))).rejects.toMatchObject({ code: "ENOENT" });
});

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { expect, it, vi } from "vitest";
import { createAutoReviewTool } from "./tool.js";

type Host = Parameters<typeof createAutoReviewTool>[0];
type Command = Host["runtime"]["system"]["runCommandWithTimeout"];
const params = { mode: "local" as const };

function fixture(
  overrides: {
    model?: string;
    passes?: number;
    settingsModel?: string;
    settingsThinking?: string;
    output?: string;
    stderr?: string;
    exitCode?: number;
    helperFailure?: string;
    extraRequestFields?: Record<string, unknown>;
    secondPass?: Record<string, unknown>;
  } = {},
) {
  const prompt = "Review the frozen shipping change.";
  const reviewModel = overrides.settingsModel ?? "fixture/preferred";
  const reviewThinking = overrides.settingsThinking ?? null;
  const request = {
    protocol: "autoreview-exec-v1",
    run_id: "fixture-run",
    pass: 1,
    passes: overrides.passes ?? 1,
    prompt,
    prompt_bytes: Buffer.byteLength(prompt),
    prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
    model: overrides.model ?? reviewModel,
    thinking: reviewThinking,
    max_result_bytes: 2_000_000,
    admitted_model: true,
    engine_timeout_seconds: null,
    ...overrides.extraRequestFields,
  };
  const report = JSON.stringify({
    findings: [{ title: "[P2] Keep the threshold inclusive" }],
    verdict: "request_changes",
  });
  let finish: ((value: { code: number; stdout: string; stderr: string }) => void) | undefined;
  let response:
    | { pass: number; status: string; output: string | null; model: string | null }
    | undefined;
  let cwd: string | undefined;
  let helperArgv: readonly string[] | undefined;
  const command = vi.fn<Command>(async (argv, options) => {
    if (typeof options === "number") {
      throw new Error("expected process options");
    }
    expect(argv.slice(0, 2)).toEqual([process.execPath, "/host/openclaw/openclaw.mjs"]);
    expect(argv).not.toContain("--config");
    expect(argv).not.toContain("--isolated");
    expect(options.baseEnv).toBeUndefined();
    expect(options.input).toBe(prompt);
    expect(options).toMatchObject({ killProcessTree: true, killGraceMs: 5_000 });
    cwd = options.cwd;
    expect(await fs.readdir(cwd!)).toEqual([]);
    return {
      stdout: overrides.output ?? '{"ok":true,"status":"ok","final":"complete"}',
      stderr: overrides.stderr ?? "",
      code: overrides.exitCode ?? 0,
      signal: null,
      killed: false,
      termination: "exit",
      cleanup: "normal",
      noOutputTimedOut: false,
    };
  });
  const admitted = vi.fn<(selection: { model: string | null; explicit: boolean }) => void>();
  const run: NonNullable<OpenClawPluginToolContext["modelExecution"]>["run"] = async (
    selection,
    action,
    signal,
  ) => {
    admitted(selection);
    const result = await action({
      model: selection.model ?? "fixture/default",
      agentId: "caller",
      signal: signal ?? new AbortController().signal,
      assertCurrent() {
        signal?.throwIfAborted();
      },
    });
    signal?.throwIfAborted();
    return result;
  };
  const context: OpenClawPluginToolContext<2> = {
    assertInvocationCurrent() {},
    assertCompleteResult() {},
    runtimeConfig: {
      tools: {
        allow: ["exec"],
        byProvider: { FIXTURE: { alsoAllow: ["process"] } },
        sandbox: { tools: { allow: ["read"] } },
      },
      agents: {
        entries: {
          caller: {
            tools: {
              alsoAllow: ["autoreview"],
              byProvider: { "Fixture/Preferred": { allow: ["write"] } },
              sandbox: { tools: { alsoAllow: ["process"] } },
              codeMode: { enabled: true },
            },
          },
        },
      },
    },
    modelExecution: { cliEntryPath: "/host/openclaw/openclaw.mjs", run },
    sandbox: {
      workspaceDir: "/guest/current-repo",
      installedSkillRoots: { autoreview: "/protected/autoreview" },
      async run({ argv, input, signal }) {
        if (argv.includes("--native-handoff")) {
          helperArgv = argv;
          return new Promise((resolve, reject) => {
            finish = resolve;
            signal?.addEventListener(
              "abort",
              () => reject(new DOMException("Cancelled", "AbortError")),
              { once: true },
            );
          });
        }
        if (argv.includes("--native-submit")) {
          response = JSON.parse(input!);
          if (response?.status !== "done" || response.pass === request.passes) {
            finish?.({
              code: response?.status === "done" ? 1 : 2,
              stdout: JSON.stringify({
                code: 1,
                report: overrides.helperFailure ? null : JSON.parse(report),
                status: overrides.helperFailure
                  ? null
                  : { report_produced: true, effective_models: [reviewModel] },
              }),
              stderr:
                overrides.helperFailure ??
                (response?.status === "done" ? "" : "reviewer unavailable"),
            });
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        return {
          code: 0,
          stdout: argv.some((arg) => arg.endsWith("/1.request.json"))
            ? JSON.stringify(request)
            : JSON.stringify({ ...request, pass: 2, ...overrides.secondPass }),
          stderr: "",
        };
      },
    },
  };
  const host: Host = { runtime: { system: { runCommandWithTimeout: command } } };
  return {
    host,
    context,
    command,
    admitted,
    tool: createAutoReviewTool(host, context)!,
    response: () => response,
    cwd: () => cwd,
    helperArgv: () => helperArgv,
    report,
  };
}

it("uses canonical settings for an ordinary target-only call and transfers complete output", async () => {
  const output = JSON.stringify({
    ok: true,
    status: "ok",
    final: "x".repeat(100000),
    model: "preferred",
    provider: "fixture",
  });
  const test = fixture({
    output,
    extraRequestFields: {
      config_override: {
        models: { providers: { fixture: { localService: { command: "/untrusted/host" } } } },
      },
      agent_override: { skills: ["private-host-skill"] },
    },
  });
  const result = await test.tool.execute("review", params);
  expect(result.content).toEqual([
    {
      type: "text",
      text: JSON.stringify({
        report: JSON.parse(test.report),
        status: { report_produced: true, effective_models: ["fixture/preferred"] },
      }),
    },
  ]);
  expect(test.response()).toMatchObject({ status: "done", output, model: "fixture/preferred" });
  for (const flag of ["--model", "--thinking", "--engine-timeout-seconds", "--max-review-passes"]) {
    expect(test.helperArgv()).not.toContain(flag);
  }
  const argv = test.command.mock.calls[0]![0];
  expect(argv).toEqual(expect.arrayContaining(["--code-mode", "direct"]));
  for (const flag of ["--model", "--thinking", "--timeout"]) {
    expect(argv).not.toContain(flag);
  }
  const overrides = argv.flatMap((arg, index) =>
    arg === "--config-override" ? [JSON.parse(argv[index + 1]!)] : [],
  );
  expect(overrides).toEqual([
    {
      tools: {
        allow: [],
        alsoAllow: [],
        byProvider: { FIXTURE: { allow: [], alsoAllow: [] } },
        sandbox: { tools: { allow: [], alsoAllow: [] } },
        deny: ["*"],
        toolSearch: false,
        codeMode: { enabled: false },
      },
      agents: {
        defaults: { systemAgent: { agentId: "caller" } },
        entries: {
          caller: {
            skills: [],
            contextInjection: "never",
            nativeRuntimeConsent: [],
            model: { primary: "fixture/preferred", fallbacks: [] },
            tools: {
              allow: [],
              alsoAllow: [],
              byProvider: { "Fixture/Preferred": { allow: [], alsoAllow: [] } },
              sandbox: { tools: { allow: [], alsoAllow: [] } },
            },
          },
        },
      },
    },
  ]);
  expect(test.admitted.mock.calls[0]![0]).toEqual({ model: "fixture/preferred", explicit: false });
  await expect(fs.stat(path.dirname(test.cwd()!))).rejects.toMatchObject({ code: "ENOENT" });
});

it("picks up changed helper defaults and forwards only requested overrides", async () => {
  const test = fixture({ settingsModel: "fixture/new-default", settingsThinking: "high" });
  await test.tool.execute("review", {
    ...params,
    maxPriority: "P2",
    passes: 12,
    timeoutSeconds: 900,
  });
  expect(test.admitted.mock.calls[0]![0]).toEqual({
    model: "fixture/new-default",
    explicit: false,
  });
  expect(test.helperArgv()).toEqual(
    expect.arrayContaining([
      "--max-priority",
      "P2",
      "--max-review-passes",
      "12",
      "--engine-timeout-seconds",
      "900",
    ]),
  );
  expect(test.command.mock.calls[0]![0]).toEqual(expect.arrayContaining(["--thinking", "high"]));
});

it.each([{ model: "fixture/substituted" }, { passes: 3 }])(
  "rejects a later request that changes the bound plan: %j",
  async (secondPass) => {
    const test = fixture({ passes: 2, secondPass });
    await expect(test.tool.execute("review", params)).rejects.toThrow("substituted prepared pass");
    expect(test.command).toHaveBeenCalledOnce();
  },
);

it("rejects an old helper or a substituted explicit model before execution", async () => {
  const old = fixture({ extraRequestFields: { admitted_model: undefined } });
  await expect(old.tool.execute("review", params)).rejects.toThrow("update the Auto Review skill");
  expect(old.command).not.toHaveBeenCalled();
  const changed = fixture({ model: "fixture/substituted" });
  await expect(
    changed.tool.execute("review", { ...params, model: "fixture/preferred" }),
  ).rejects.toThrow("substituted prepared pass");
  expect(changed.command).not.toHaveBeenCalled();
});

it("submits a failed CLI result as failure with bounded redacted diagnostics", async () => {
  const test = fixture({
    exitCode: 1,
    stderr: `${"x".repeat(5000)}\nAuthorization: Bearer unrelated-fake-secret-token`,
  });
  const failure = await test.tool.execute("review", params).catch((error: unknown) => error);
  if (!(failure instanceof Error)) {
    throw new Error("Expected reviewer failure");
  }
  expect(failure.message).toContain("reviewer unavailable");
  expect(failure.message).toContain("Reviewer command failed (exit 1, exit, cleanup normal");
  expect(failure.message).not.toContain("unrelated-fake-secret-token");
  expect(failure.message.length).toBeLessThan(4300);
  expect(test.response()).toMatchObject({ status: "failed", output: null, model: null });
  expect(test.command).toHaveBeenCalledOnce();
});

it("preserves the canonical diagnostic when no report is produced", async () => {
  const diagnostic =
    "source changed after the review bundle was created; rerun autoreview against the updated tree";
  await expect(
    fixture({ helperFailure: diagnostic }).tool.execute("review", params),
  ).rejects.toThrow(diagnostic);
});

it("withholds the tool without protected installation or current authority", () => {
  const test = fixture();
  expect(
    createAutoReviewTool(test.host, {
      ...test.context,
      sandbox: { ...test.context.sandbox!, installedSkillRoots: {} },
    }),
  ).toBeNull();
  expect(
    createAutoReviewTool(test.host, { ...test.context, modelExecution: undefined }),
  ).toBeNull();
});

it.each([{ passes: 0 }, { timeoutSeconds: 0 }, { openclawBin: "/untrusted" }])(
  "rejects invalid arguments before execution: %j",
  async (override) => {
    const test = fixture();
    await expect(test.tool.execute("review", { ...params, ...override })).rejects.toThrow(
      "Invalid Auto Review arguments",
    );
    expect(test.command).not.toHaveBeenCalled();
  },
);

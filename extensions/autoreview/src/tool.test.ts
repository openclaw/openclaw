import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { expect, it, vi } from "vitest";
import { createAutoReviewTool } from "./tool.js";

type Host = Parameters<typeof createAutoReviewTool>[0];
type Command = Host["runtime"]["system"]["runCommandWithTimeout"];
const selectedModel = {
  id: "review",
  provider: "fixture",
  api: "openai-responses" as const,
  name: "Review",
  baseUrl: "https://example.invalid/v1",
  reasoning: true,
  input: ["text" as const],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};
const params = { model: "fixture/review", thinking: "high", maxPriority: "P2" };

function fixture(
  overrides: { model?: string; passes?: number; output?: string; exitCode?: number } = {},
) {
  const prompt = "Review the frozen shipping change.";
  const request = {
    protocol: "autoreview-exec-v1",
    run_id: "fixture-run",
    pass: 1,
    passes: overrides.passes ?? 1,
    prompt,
    prompt_bytes: Buffer.byteLength(prompt),
    prompt_sha256: createHash("sha256").update(prompt).digest("hex"),
    model: overrides.model ?? params.model,
    thinking: "high",
    max_result_bytes: 2_000_000,
  };
  const report = JSON.stringify({
    findings: [{ title: "[P2] Keep the threshold inclusive" }],
    verdict: "request_changes",
  });
  let finish: ((value: { code: number; stdout: string; stderr: string }) => void) | undefined;
  let response: { status: string; output: string | null } | undefined;
  let config: unknown;
  let home: string | undefined;
  const command = vi.fn<Command>(async (_argv, options) => {
    if (typeof options === "number") {
      throw new Error("expected bounded process options");
    }
    expect(_argv.slice(0, 2)).toEqual([process.execPath, "/host/openclaw/openclaw.mjs"]);
    const file = _argv[_argv.indexOf("--config") + 1]!;
    config = JSON.parse(await fs.readFile(file, "utf8"));
    home = options.baseEnv?.HOME;
    expect(options.input).toBe(prompt);
    expect(options.baseEnv).not.toHaveProperty("OPENAI_API_KEY");
    expect(await fs.readdir(home!)).toEqual([]);
    return {
      stdout: overrides.output ?? '{"ok":true,"status":"ok","final":"complete"}',
      stderr: "",
      code: overrides.exitCode ?? 0,
      signal: null,
      killed: false,
      termination: "exit",
      cleanup: "normal",
      noOutputTimedOut: false,
    };
  });
  const context: OpenClawPluginToolContext<2> = {
    assertInvocationCurrent() {},
    assertCompleteResult() {},
    resolveApiKeyForProvider: async () => "fixture-private-key",
    modelExecution: {
      cliEntryPath: "/host/openclaw/openclaw.mjs",
      async run(_model, action, signal) {
        return action({
          model: selectedModel,
          signal: signal ?? new AbortController().signal,
          assertCurrent() {},
        });
      },
    },
    sandbox: {
      workspaceDir: "/guest/current-repo",
      installedSkillRoots: { autoreview: "/protected/autoreview" },
      async run({ argv, input, signal }) {
        if (argv.includes("--native-handoff")) {
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
          finish?.({
            code: response?.status === "done" ? 1 : 2,
            stdout: JSON.stringify({
              code: 1,
              report: JSON.parse(report),
              status: { report_produced: true },
            }),
            stderr: response?.status === "done" ? "" : "reviewer unavailable",
          });
          return { code: 0, stdout: "", stderr: "" };
        }
        if (input !== undefined) {
          response = JSON.parse(input);
          return { code: 0, stdout: "", stderr: "" };
        }
        return {
          code: 0,
          stdout: argv.some((arg) => arg.endsWith("/1.request.json"))
            ? JSON.stringify(request)
            : "",
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
    tool: createAutoReviewTool(host, context)!,
    response: () => response,
    config: () => config,
    home: () => home,
    report,
  };
}

it("returns the helper verdict and transfers complete CLI output under fixed host restrictions", async () => {
  const output = JSON.stringify({
    ok: true,
    status: "ok",
    final: "x".repeat(100000),
    model: "review",
    provider: "fixture",
  });
  const test = fixture({ output });
  const result = await test.tool.execute("review", params);
  expect(result.content).toEqual([{ type: "text", text: test.report }]);
  expect(test.response()).toEqual(expect.objectContaining({ status: "done", output }));
  expect(test.config()).toMatchObject({
    tools: { deny: ["*"] },
    plugins: { allow: [] },
    agents: { entries: { main: { skills: [], contextInjection: "never" } } },
    models: {
      providers: { fixture: { apiKey: "fixture-private-key", models: [{ id: "review" }] } },
    },
  });
  await expect(fs.stat(path.dirname(test.home()!))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each([{ model: "fixture/unapproved" }, { passes: 9 }])(
  "rejects a prepared request outside granted execution: %j",
  async (override) => {
    const test = fixture(override);
    await expect(test.tool.execute("review", params)).rejects.toThrow("substituted prepared pass");
    expect(test.command).not.toHaveBeenCalled();
  },
);

it("submits a failed CLI result as failure and never changes engines", async () => {
  const test = fixture({ exitCode: 1 });
  await expect(test.tool.execute("review", params)).rejects.toThrow("reviewer unavailable");
  expect(test.response()).toMatchObject({ status: "failed", output: null });
  expect(test.command).toHaveBeenCalledOnce();
});

it("withholds the tool without a selected protected installation or current model capability", () => {
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

it.each([
  { passes: 9 },
  { timeoutSeconds: 601 },
  { timeoutSeconds: 0 },
  { openclawBin: "/untrusted" },
])("rejects arguments outside the fixed operation before execution: %j", async (override) => {
  const test = fixture();
  await expect(test.tool.execute("review", { ...params, ...override })).rejects.toThrow(
    "Invalid Auto Review arguments",
  );
  expect(test.command).not.toHaveBeenCalled();
});

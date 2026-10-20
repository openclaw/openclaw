import fs from "node:fs/promises";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { nestedToolActivityFixture } from "../test/nested-tool-activity-fixture.js";
import {
  cleanupRuntimeToolFixtureTempRoots,
  makeEnv,
  MOCK_BASE_URL,
  mockToolRequests,
  runLiveRuntimeToolFixture as runLiveFixture,
  runMockRuntimeToolFixture as runMockFixture,
  runtimePatchAddInput,
  runtimePatchUpdateInput,
  runtimeToolFixtureConfig,
  runtimeToolFixtureDeps,
  simulateRuntimePatchHappyTurn,
  transcriptToolCall,
  transcriptToolResult,
  writeQaSessionTranscript,
  writeRuntimeToolTranscripts,
  type RuntimeToolFixtureConfig,
  type RuntimeToolFixtureDeps,
} from "../test/runtime-tool-fixture-helpers.js";
import { QaSuiteInfraError } from "./errors.js";
import { runRuntimeToolFixture } from "./runtime-tool-fixture.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";

const PATCH_ADDED = "apply_patch live provider happy planned args";
const PATCH_FILE = "runtime-tool-fixture-patch.txt";
const DENIED_FILE = "../runtime-tool-fixture-denied.txt";
const nativeCoverage = {
  bucket: "codex-native-workspace",
  expectedLayer: "codex-native-workspace",
} as const;
const PATCH_CREATE_ERROR =
  "expected apply_patch to create runtime-tool-fixture-patch.txt with exact contents";
const PATCH_UPDATE_ERROR =
  "expected linked live apply_patch to update ../runtime-tool-fixture-denied.txt";
const PATCH_BOUNDARY_ERROR =
  "expected live apply_patch failure to explicitly reject the workspace boundary";

async function expectRejected(operation: Promise<unknown>, message: string) {
  await expect(operation).rejects.toThrow(message);
}
async function expectAbsent(file: string) {
  await expect(fs.access(file)).rejects.toThrow();
}
type NativeOptions = NonNullable<Parameters<typeof writeCodexNativePatchEvidence>[2]>;
type NativeSetup = (env: QaSuiteRuntimeEnv) => NativeOptions | Promise<NativeOptions>;

async function makeCodexEnv() {
  const env = await makeEnv();
  env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
  return env;
}

function patchCall(phase: "happy" | "failure" | "unlinked-decoy", args: unknown) {
  const call = {
    type: "toolCall",
    id: `native-patch-${phase}`,
    name: "apply_patch",
    arguments: args,
  };
  return { role: "assistant", content: [call] };
}

function patchResult(phase: "happy" | "failure", content: string, isError: boolean) {
  const identity = { toolName: "apply_patch", toolCallId: `native-patch-${phase}` };
  const result = { type: "toolResult", ...identity, content };
  return { role: "toolResult", ...identity, isError, content: [result] };
}

async function writeCodexNativePatchEvidence(
  env: QaSuiteRuntimeEnv,
  failureOutput = "apply_patch failed: path escapes sandbox root",
  options: {
    happyPath?: string;
    failureKind?: string;
    failureStructuredError?: boolean;
    happyArguments?: unknown;
    failureArguments?: unknown;
    omitFailureEvidence?: boolean;
  } = {},
) {
  for (const phase of ["happy", "failure"] as const) {
    if (phase === "failure" && options.omitFailureEvidence) {
      return;
    }
    const happy = phase === "happy";
    const args = happy ? options.happyArguments : options.failureArguments;
    const target = happy ? (options.happyPath ?? PATCH_FILE) : DENIED_FILE;
    const kind = happy ? "add" : (options.failureKind ?? "update");
    await writeQaSessionTranscript(env, `agent:qa:runtime-tool:apply_patch:${phase}`, [
      patchCall(phase, args ?? { changes: [{ path: target, kind: { type: kind } }] }),
      patchResult(
        phase,
        happy ? "apply_patch completed" : failureOutput,
        happy ? false : (options.failureStructuredError ?? true),
      ),
    ]);
  }
}

function nativePatchFixtureConfig(): RuntimeToolFixtureConfig {
  return runtimeToolFixtureConfig("apply_patch", {
    toolCoverage: { ...nativeCoverage, required: true },
  });
}

function runNativePatchFixture(
  env: QaSuiteRuntimeEnv,
  params: {
    runAgentPrompt?: RuntimeToolFixtureDeps["runAgentPrompt"];
  } = {},
) {
  return runLiveFixture(env, {
    toolName: "apply_patch",
    config: nativePatchFixtureConfig(),
    tools: [],
    runAgentPrompt: params.runAgentPrompt ?? vi.fn(simulateRuntimePatchHappyTurn),
  });
}

function asyncImageFixtureConfig() {
  return runtimeToolFixtureConfig("image_generate", {
    toolCoverage: {
      bucket: "openclaw-dynamic-integration",
      expectedLayer: "openclaw-dynamic",
      required: false,
      action: "optional runtime parity gate with async image completion coverage",
    },
  });
}

const patchDefaults = () => ({
  toolName: "apply_patch",
  happyArgs: { input: runtimePatchAddInput() },
  failureArgs: { input: runtimePatchUpdateInput() },
  happyOutput: "Successfully applied patch",
  failureOutput: "Error: Path escapes sandbox root",
});
function patchRequests(overrides: Parameters<typeof mockToolRequests>[0] = {}) {
  return mockToolRequests({ ...patchDefaults(), ...overrides });
}
function runMockPatchFixture(
  overrides: Parameters<typeof mockToolRequests>[0] & { happyPatchContents?: string | null } = {},
) {
  return runMockFixture({
    toolName: "apply_patch",
    requests: patchRequests(overrides),
    runAgentPrompt: vi.fn((env, params) =>
      simulateRuntimePatchHappyTurn(env, params, overrides.happyPatchContents),
    ),
  });
}
function runAsyncImageFixture(requests: Parameters<typeof mockToolRequests>[0]) {
  return runMockFixture({
    toolName: "image_generate",
    config: asyncImageFixtureConfig(),
    requests: mockToolRequests({
      toolName: "image_generate",
      happyArgs: { prompt: "QA lighthouse" },
      failureArgs: { __qaFailureMode: "denied-input" },
      omitHappyOutput: true,
      omitFailureOutput: true,
      ...requests,
    }),
  });
}

afterEach(() => {
  resetPluginStateStoreForTests({ closeDatabase: false });
});
afterAll(cleanupRuntimeToolFixtureTempRoots);

describe("runtime tool fixture", () => {
  it("retains both fixture session keys when the failure prompt throws", async () => {
    const env = await makeEnv();
    const infraError = new QaSuiteInfraError("agent_wait_failed", "failure prompt did not settle");
    const runAgentPrompt = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(infraError);

    const result = runLiveFixture(env, { runAgentPrompt });
    await expect(result).rejects.toBeInstanceOf(QaSuiteInfraError);
    await expect(result).rejects.toMatchObject({ code: "agent_wait_failed", cause: infraError });
    await expectRejected(
      result,
      [
        "RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:read:happy",
        "RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:read:failure",
        "failure prompt did not settle",
      ].join("\n"),
    );
  });

  it("skips Codex-native fixtures when only OpenClaw dynamic exposure evidence is absent", async () => {
    const env = await makeEnv({ mock: { baseUrl: MOCK_BASE_URL } });
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
    env.gateway.workspaceDir = env.repoRoot;

    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ cursor: 0 })
      .mockResolvedValueOnce([
        {
          allInputText: "target=read",
          plannedToolName: "read",
          plannedToolArgs: { path: "README.md" },
        },
      ]);

    const runAgentPrompt = vi.fn<RuntimeToolFixtureDeps["runAgentPrompt"]>().mockResolvedValue({});
    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "read",
          toolCoverage: {
            ...nativeCoverage,
            reason: "Codex owns read natively.",
          },
          promptSnippet: "target=read",
          failurePromptSnippet: "failure target=read",
        },
        runtimeToolFixtureDeps({ tools: [], runAgentPrompt, fetchJson }),
      ),
    ).rejects.toMatchObject({
      name: "QaSuiteScenarioSkipError",
      message: expect.stringMatching(
        /codex-native-workspace read[\s\S]*RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:read:happy[\s\S]*RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:read:failure/u,
      ),
    });
    expect(runAgentPrompt).toHaveBeenCalledTimes(2);
    expect(runAgentPrompt.mock.calls.map(([, params]) => params.transcriptToolName)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("rejects a native patch whose recorded working directory changes its target", async () => {
    const env = await makeCodexEnv();
    await writeCodexNativePatchEvidence(env, "apply_patch failed: path escapes sandbox root", {
      happyArguments: {
        input: runtimePatchAddInput(),
        cwd: path.resolve(env.gateway.workspaceDir, ".."),
      },
    });

    await expectRejected(
      runNativePatchFixture(env),
      "expected linked live apply_patch to add runtime-tool-fixture-patch.txt",
    );
  });

  it.each<[string, NativeSetup, string]>([
    [
      "freeform",
      () => ({
        happyArguments: runtimePatchAddInput(),
        failureArguments: runtimePatchUpdateInput(),
      }),
      "patch rejected: writing outside of the project",
    ],
    [
      "JSON arguments",
      () => ({
        happyArguments: JSON.stringify({ input: runtimePatchAddInput() }),
        failureArguments: JSON.stringify({ input: runtimePatchUpdateInput() }),
      }),
      "patch rejected: writing outside of the project",
    ],
    [
      "workspace alias",
      async (env) => {
        const alias = path.join(env.gateway.tempRoot, "workspace-alias");
        await fs.symlink(
          env.gateway.workspaceDir,
          alias,
          process.platform === "win32" ? "junction" : "dir",
        );
        return { happyPath: path.join(alias, PATCH_FILE) };
      },
      "apply_patch failed: path escapes sandbox root",
    ],
    [
      "absolute targets without a hunk",
      (env) => {
        const happy = path.join(env.gateway.workspaceDir, PATCH_FILE);
        const denied = path.resolve(env.gateway.workspaceDir, DENIED_FILE);
        return {
          happyArguments: {
            input: `*** Begin Patch\n*** Add File: ${happy}\n+runtime patch\n*** End Patch\n`,
          },
          failureArguments: {
            input: `*** Begin Patch\n*** Update File: ${denied}\n-runtime-tool-fixture-denied-original\n+runtime patch outside the workspace\n*** End Patch\n`,
          },
        };
      },
      "patch rejected: writing outside of the project",
    ],
    [
      "linked call after a decoy",
      async (env) => {
        await writeQaSessionTranscript(env, "agent:qa:runtime-tool:apply_patch:happy", [
          patchCall("unlinked-decoy", {
            changes: [{ path: "runtime-tool-fixture-wrong.txt", kind: { type: "add" } }],
          }),
        ]);
        return {};
      },
      "apply_patch failed: path escapes sandbox root",
    ],
  ])("verifies native patch %s and containment", async (_name, prepare, output) => {
    const env = await makeCodexEnv();
    await writeCodexNativePatchEvidence(env, output, await prepare(env));
    await expect(runNativePatchFixture(env)).resolves.toContain(PATCH_ADDED);
    await expectAbsent(path.resolve(env.gateway.workspaceDir, DENIED_FILE));
  });

  it("does not accept assistant text as evidence of a native Codex workspace rejection", async () => {
    const env = await makeCodexEnv();
    await writeCodexNativePatchEvidence(env, undefined, { omitFailureEvidence: true });
    await writeQaSessionTranscript(env, "agent:qa:runtime-tool:apply_patch:failure", [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "patch rejected: writing outside of the project; rejected by user approval settings",
          },
        ],
      },
    ]);

    await expectRejected(
      runNativePatchFixture(env),
      "expected live failure-path tool call for apply_patch",
    );

    await expectAbsent(path.resolve(env.gateway.workspaceDir, DENIED_FILE));
  });

  it.each<
    [
      NativeOptions & {
        output?: string;
        runAgentPrompt?: RuntimeToolFixtureDeps["runAgentPrompt"];
      },
      string,
    ]
  >([
    [{ runAgentPrompt: vi.fn(async () => ({})) }, PATCH_CREATE_ERROR],
    [
      {
        output:
          "apply_patch failed: failed to find expected lines in runtime-tool-fixture-denied.txt",
      },
      PATCH_BOUNDARY_ERROR,
    ],
    [
      { output: "apply_patch completed", failureStructuredError: false },
      "expected live failure-path tool failure output for apply_patch",
    ],
    [{ failureKind: "add" }, PATCH_UPDATE_ERROR],
  ])(
    "rejects invalid native patch evidence: %j",
    async ({ output, runAgentPrompt, ...options }, expected) => {
      const env = await makeCodexEnv();
      await writeCodexNativePatchEvidence(env, output, options);
      await expectRejected(runNativePatchFixture(env, { runAgentPrompt }), expected);
    },
  );

  it("fails closed and cleans up when a patch changes the outside-workspace sentinel", async () => {
    const env = await makeEnv();
    const sentinelPath = path.resolve(env.gateway.workspaceDir, DENIED_FILE);

    await expectRejected(
      runLiveFixture(env, {
        toolName: "apply_patch",
        runAgentPrompt: vi.fn(async (_env, params) => {
          if (params.sessionKey.endsWith(":failure")) {
            expect(await fs.readFile(sentinelPath, "utf8")).toBe(
              "runtime-tool-fixture-denied-original\n",
            );
            await fs.writeFile(sentinelPath, "runtime patch outside the workspace\n", "utf8");
          }
          return simulateRuntimePatchHappyTurn(_env, params);
        }),
      }),
      "apply_patch modified or removed the outside-workspace sentinel",
    );

    await expectAbsent(sentinelPath);
  });

  it("verifies native-only private-QA Codex patch calls without skipping them", async () => {
    const env = await makeEnv({ mock: { baseUrl: MOCK_BASE_URL } });
    const runAgentPrompt = vi.fn<RuntimeToolFixtureDeps["runAgentPrompt"]>(
      simulateRuntimePatchHappyTurn,
    );
    const details = await runMockFixture({
      env,
      toolName: "apply_patch",
      requests: patchRequests({
        happyCallId: "private-qa-patch-happy",
        failureCallId: "private-qa-patch-failure",
      }),
      config: nativePatchFixtureConfig(),
      tools: [],
      forceCodex: true,
      runAgentPrompt,
    });

    expect(
      runAgentPrompt.mock.calls.map(([, params]) => ({
        transcriptToolName: params.transcriptToolName,
        requireSuccessfulTranscriptToolResult: params.requireSuccessfulTranscriptToolResult,
      })),
    ).toEqual([
      { transcriptToolName: undefined, requireSuccessfulTranscriptToolResult: undefined },
      { transcriptToolName: undefined, requireSuccessfulTranscriptToolResult: undefined },
    ]);
    expect(details).toContain("apply_patch mock provider happy planned args");
    expect(details).toContain("runtime-tool-fixture-patch.txt");
    expect(details).toContain("../runtime-tool-fixture-denied.txt");
    expect(details).not.toContain("codex-native-workspace apply_patch");
    await expectAbsent(path.resolve(env.gateway.workspaceDir, DENIED_FILE));
    await expectAbsent(path.join(env.gateway.workspaceDir, PATCH_FILE));
  });

  it.each<[Parameters<typeof runMockPatchFixture>[0], string]>([
    [
      { failureOutput: "Error: failed to find expected lines in runtime-tool-fixture-denied.txt" },
      "expected mock apply_patch failure to explicitly reject the workspace boundary",
    ],
    [{ happyPatchContents: null }, PATCH_CREATE_ERROR],
    [
      {
        failureArgs: {
          input: runtimePatchUpdateInput().replace(
            "+runtime patch outside the workspace",
            "+incorrect replacement",
          ),
        },
      },
      "expected linked mock apply_patch to update ../runtime-tool-fixture-denied.txt",
    ],
  ])("rejects invalid mock patch evidence %j", async (options, expected) => {
    await expectRejected(runMockPatchFixture(options), expected);
  });

  it("skips Codex-native async planned-only fixtures without treating the plan as proof", async () => {
    await expectRejected(
      runMockFixture({
        toolName: "image_generate",
        requests: mockToolRequests({
          toolName: "image_generate",
          happyArgs: { prompt: "QA lighthouse runtime parity fixture" },
          failureArgs: { __qaFailureMode: "denied-input" },
          omitHappyOutput: true,
          failureOutput: "Error: denied-input",
        }),
        config: runtimeToolFixtureConfig("image_generate", {
          toolCoverage: {
            ...nativeCoverage,
            reason: "Codex owns image generation natively in this fixture.",
          },
          happyPathOutputRequired: false,
        }),
        tools: [],
        forceCodex: true,
      }),
      "image_generate mock provider report-only",
    );
  });

  it("requires mock runtime tool fixtures to produce tool output", async () => {
    const requests = [
      {
        allInputText: "target=read",
        plannedToolName: "read",
        plannedToolArgs: { path: "README.md" },
      },
      {
        allInputText: "failure target=read",
        plannedToolName: "read",
        plannedToolArgs: { path: "/missing" },
      },
      { allInputText: "failure target=read", toolOutput: "ENOENT: no such file or directory" },
    ];

    await expectRejected(
      runMockFixture({ requests }),
      "expected mock happy-path tool output for read",
    );
  });

  it.each<[Parameters<typeof runAsyncImageFixture>[0], string]>([
    [
      { happyArgs: { prompt: "QA lighthouse", filename: "runtime-tool-fixture" } },
      "image_generate mock provider report-only",
    ],
    [
      { omitFailureOutput: false, failureOutput: "Task queued for async image delivery" },
      "expected mock failure-path tool failure output for image_generate",
    ],
    [
      { failureArgs: { prompt: "not a denied-input failure" } },
      "expected mock failure-path denied-input args for image_generate",
    ],
    [{ happyArgs: {} }, "expected mock happy-path prompt args for image_generate"],
  ])("checks optional image evidence %j", async (request, expected) => {
    await expectRejected(runAsyncImageFixture(request), expected);
  });

  it("rejects unavailable-provider happy output as mock fixture output", async () => {
    await expectRejected(
      runMockFixture({
        toolName: "web_search",
        requests: mockToolRequests({
          toolName: "web_search",
          happyArgs: { query: "OpenClaw runtime parity fixed query" },
          failureArgs: { __qaFailureMode: "denied-input" },
          happyOutput: "web_search is disabled or no provider is available.",
          failureOutput: "web_search is disabled or no provider is available.",
        }),
      }),
      "expected mock happy-path successful tool output for web_search",
    );
  });
});

it.each([
  { phase: "unavailable tool", tools: [], requests: [] },
  { phase: "missing failure output", requests: mockToolRequests({ omitFailureOutput: true }) },
  {
    phase: "successful failure output",
    requests: mockToolRequests({ failureOutput: "README contents" }),
  },
])("preserves an explicit known harness gap for $phase", async ({ requests, ...fixture }) => {
  await expect(
    runMockFixture({
      requests,
      tools: "tools" in fixture ? fixture.tools : undefined,
      config: { knownHarnessGap: { reason: "QA fixture unavailable", issue: "#80319" } },
    }),
  ).rejects.toMatchObject({
    name: "QaSuiteScenarioSkipError",
    message: [
      "known-harness-gap read: QA fixture unavailable",
      "tracking: #80319",
      "RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:read:happy",
      "RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:read:failure",
    ].join("\n"),
  });
});

describe("runtime tool fixture mock request linking", () => {
  it("validates the linked mock patch after an unlinked plan", async () => {
    const requests = patchRequests();
    await expect(
      runMockFixture({
        toolName: "apply_patch",
        requests: [
          {
            allInputText: "target=apply_patch",
            plannedToolCallId: "unlinked-decoy",
            plannedToolName: "apply_patch",
            plannedToolArgs: { input: runtimePatchAddInput("runtime-tool-fixture-wrong.txt") },
          },
          { ...requests[0], ...requests[1] },
          ...requests.slice(2),
        ],
        runAgentPrompt: vi.fn(simulateRuntimePatchHappyTurn),
      }),
    ).resolves.toContain("apply_patch mock provider happy planned args");
  });

  it("rejects mismatched planned and output call ids on the same mock request", async () => {
    const requests = mockToolRequests({});
    await expectRejected(
      runMockFixture({
        requests: [
          {
            ...requests[0],
            toolOutputCallId: "call-write-previous",
            toolOutput: "previous write output",
          },
          ...requests.slice(2),
        ],
      }),
      "expected mock happy-path tool output for read",
    );
  });
});

it.each(["correlated success and error", "missing nested result"])(
  "validates nested runtime evidence: %s",
  async (testCase) => {
    const missingResult = testCase === "missing nested result";
    const env = await makeEnv();
    const receipt = (phase: "happy" | "failure") => {
      const activity = nestedToolActivityFixture({
        toolName: "web_fetch",
        toolCallId: `nested-${phase}`,
        input: { url: phase === "happy" ? "https://example.com/" : "file:///denied" },
        text: "completed",
        isError: phase === "failure",
      });
      return {
        ...activity,
        details: {
          ...activity.details,
          result: missingResult ? undefined : activity.details.result,
        },
      };
    };
    const happy: Array<Record<string, unknown>> = [receipt("happy")];
    if (!missingResult) {
      happy.unshift({
        role: "toolResult",
        toolName: "unrelated",
        toolCallId: "nested-happy",
        isError: true,
        content: "failed unrelated tool",
      });
    }
    await writeRuntimeToolTranscripts(env, "web_fetch", happy, [receipt("failure")]);
    const result = runRuntimeToolFixture(
      env,
      runtimeToolFixtureConfig("web_fetch"),
      runtimeToolFixtureDeps({ tools: ["web_fetch"] }),
    );
    if (missingResult) {
      await expectRejected(result, "expected live happy-path tool call for web_fetch");
    } else {
      await expect(result).resolves.toContain('"url":"https://example.com/"');
    }
  },
);

async function runTranscriptFixture(
  happyMessages: Array<Record<string, unknown>>,
  {
    toolName = "read",
    asyncOutput = false,
  }: {
    toolName?: string;
    asyncOutput?: boolean;
  } = {},
) {
  const env = await makeEnv();
  await writeRuntimeToolTranscripts(env, toolName, happyMessages, [
    transcriptToolCall(
      toolName,
      "failure",
      toolName === "image_generate"
        ? { __qaFailureMode: "denied-input" }
        : toolName === "read"
          ? { path: "/missing" }
          : { command: "denied" },
    ),
    transcriptToolResult(toolName, "failure", "permission denied", true),
  ]);
  return runLiveFixture(env, {
    toolName,
    ...(asyncOutput
      ? { config: runtimeToolFixtureConfig(toolName, { happyPathOutputRequired: false }) }
      : {}),
  });
}

describe("runtime tool fixture transcript evidence", () => {
  it.each(["missing", "empty"])(
    "reports a %s transcript with its fixture sessions",
    async (state) => {
      const env = await makeEnv();
      if (state === "empty") {
        await writeRuntimeToolTranscripts(env, "read", [], []);
      }
      const result = runLiveFixture(env);
      await expect(result).rejects.toThrow(
        state === "missing"
          ? "session transcript entry not found for agent:qa:runtime-tool:read:happy"
          : "session transcript is empty for agent:qa:runtime-tool:read:happy",
      );
      await expect(result).rejects.toThrow(
        "RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:read:happy",
      );
      await expect(result).rejects.toThrow(
        "RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:read:failure",
      );
    },
  );

  it("prepares the authored config instead of seeding a stale runtime store", async () => {
    const env = await makeEnv();
    const staleStorePath = path.join(env.gateway.tempRoot, "state", "stale.sqlite");
    env.cfg = { agents: { defaults: { workspace: env.gateway.workspaceDir } } };
    setRuntimeConfigSnapshot({ session: { store: staleStorePath } });

    await writeRuntimeToolTranscripts(
      env,
      "read",
      [
        transcriptToolCall("read", "happy", { path: "README.md" }),
        transcriptToolResult("read", "happy", "README contents"),
      ],
      [
        transcriptToolCall("read", "failure", { path: "/missing" }),
        transcriptToolResult("read", "failure", "permission denied", true),
      ],
    );

    expect(getRuntimeConfigSnapshot()).toEqual(env.cfg);
    await expect(runLiveFixture(env)).resolves.toContain("read live provider happy planned args");
    await expectAbsent(staleStorePath);
  });

  it.each([
    {
      name: "native cell wait control output",
      toolName: "wait",
      happyMessages: [
        transcriptToolCall("exec", "happy", { input: 'await Promise.resolve("done");' }),
        transcriptToolResult(
          "exec",
          "happy",
          "Script running with cell ID native-cell\nWall time 0.01 seconds\nOutput:\n",
        ),
        transcriptToolCall("wait", "happy", {
          arguments: JSON.stringify({ cell_id: "native-cell" }),
        }),
        transcriptToolResult("wait", "happy", "done"),
      ],
      expectedError: "expected live happy-path tool call for wait",
    },
    {
      name: "an exec result that precedes its call",
      happyMessages: [
        transcriptToolResult("exec", "happy", "done"),
        transcriptToolCall("exec", "happy", { command: "proof" }),
      ],
      expectedError: "expected live happy-path tool output for exec",
    },
    {
      name: "a nonzero physical exit despite isError=false",
      happyMessages: [
        transcriptToolCall("exec", "happy", { command: "proof" }),
        {
          ...transcriptToolResult("exec", "happy", "process completed", false),
          details: { status: "completed", exitCode: 1 },
        },
      ],
      expectedError: "expected live happy-path successful tool output for exec",
    },
  ])(
    "rejects $name as runtime execution proof",
    async ({ happyMessages, expectedError, toolName = "exec" }) => {
      await expectRejected(runTranscriptFixture(happyMessages, { toolName }), expectedError);
    },
  );

  it.each([false, true])(
    "links provider function calls to nameless results without rewriting arguments (block fallback: %s)",
    async (blockFallback) => {
      const env = await makeEnv();
      const happyArgs = '{"path":"README.md"}';
      await writeRuntimeToolTranscripts(
        env,
        "read",
        [
          {
            role: "assistant",
            tool_calls: [
              { id: "provider-happy", function: { name: "read", arguments: happyArgs } },
            ],
          },
          {
            role: "tool",
            tool_call_id: "provider-happy",
            content: blockFallback
              ? [{ message: "README contents", error: "permission denied" }]
              : "README contents",
          },
        ],
        [
          {
            role: "assistant",
            function_call: {
              id: "provider-failure",
              name: "read",
              arguments: '{"path":"/missing"}',
            },
          },
          blockFallback
            ? {
                role: "tool",
                tool_call_id: "provider-failure",
                content: [{ error: "permission denied" }],
              }
            : {
                role: "user",
                content: [
                  { type: "tool_result_error", tool_use_id: "provider-failure", content: "denied" },
                ],
              },
        ],
      );

      await expect(runLiveFixture(env)).resolves.toContain(JSON.stringify(happyArgs));
    },
  );

  it("skips async live runtime tool fixtures when the happy path has no result", async () => {
    await expectRejected(
      runTranscriptFixture(
        [
          transcriptToolCall("image_generate", "happy", {
            prompt: "QA lighthouse runtime parity fixture",
          }),
        ],
        { toolName: "image_generate", asyncOutput: true },
      ),
      "planned call without a linked successful result",
    );
  });
});

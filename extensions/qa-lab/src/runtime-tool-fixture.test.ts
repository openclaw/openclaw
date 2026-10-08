// Qa Lab tests cover runtime tool fixture plugin behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { nestedToolActivityFixture } from "../test/nested-tool-activity-fixture.js";
import {
  cleanupRuntimeToolFixtureTempRoots,
  makeEnv,
  MOCK_BASE_URL,
  mockToolRequests,
  runLiveRuntimeToolFixture,
  runMockRuntimeToolFixture,
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

async function writeCodexNativePatchEvidence(
  env: QaSuiteRuntimeEnv,
  failureOutput = "apply_patch failed: path escapes sandbox root",
  options: {
    happyPath?: string;
    failureKind?: string;
    failureStructuredError?: boolean;
    happyArguments?: unknown;
    failureArguments?: unknown;
    happyInput?: unknown;
    failureInput?: unknown;
    omitFailureEvidence?: boolean;
  } = {},
) {
  const toolName = "apply_patch";
  await writeQaSessionTranscript(env, `agent:qa:runtime-tool:${toolName}:happy`, [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "native-patch-happy",
          name: toolName,
          ...(options.happyInput !== undefined ? { input: options.happyInput } : {}),
          arguments: options.happyArguments ?? {
            changes: [
              {
                path: options.happyPath ?? "runtime-tool-fixture-patch.txt",
                kind: { type: "add" },
              },
            ],
          },
        },
      ],
    },
    {
      role: "toolResult",
      toolName,
      toolCallId: "native-patch-happy",
      isError: false,
      content: [
        {
          type: "toolResult",
          toolName,
          toolCallId: "native-patch-happy",
          content: "apply_patch completed",
        },
      ],
    },
  ]);
  if (options.omitFailureEvidence) {
    return;
  }
  await writeQaSessionTranscript(env, `agent:qa:runtime-tool:${toolName}:failure`, [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "native-patch-failure",
          name: toolName,
          ...(options.failureInput !== undefined ? { input: options.failureInput } : {}),
          arguments: options.failureArguments ?? {
            changes: [
              {
                path: "../runtime-tool-fixture-denied.txt",
                kind: { type: options.failureKind ?? "update" },
              },
            ],
          },
        },
      ],
    },
    {
      role: "toolResult",
      toolName,
      toolCallId: "native-patch-failure",
      isError: options.failureStructuredError ?? true,
      content: [
        {
          type: "toolResult",
          toolName,
          toolCallId: "native-patch-failure",
          content: failureOutput,
        },
      ],
    },
  ]);
}

function nativePatchFixtureConfig(): RuntimeToolFixtureConfig {
  return runtimeToolFixtureConfig("apply_patch", {
    toolCoverage: {
      bucket: "codex-native-workspace",
      expectedLayer: "codex-native-workspace",
      required: true,
    },
  });
}

function runNativePatchFixture(
  env: QaSuiteRuntimeEnv,
  params: {
    runAgentPrompt?: RuntimeToolFixtureDeps["runAgentPrompt"];
  } = {},
) {
  return runLiveRuntimeToolFixture(env, {
    toolName: "apply_patch",
    config: nativePatchFixtureConfig(),
    tools: [],
    runAgentPrompt: params.runAgentPrompt ?? vi.fn(simulateRuntimePatchHappyTurn),
  });
}

function asyncImageFixtureConfig(overrides: RuntimeToolFixtureConfig = {}) {
  return runtimeToolFixtureConfig("image_generate", {
    toolCoverage: {
      bucket: "openclaw-dynamic-integration",
      expectedLayer: "openclaw-dynamic",
      required: false,
      action: "optional runtime parity gate with async image completion coverage",
    },
    promptSnippet: "target=image_generate",
    failurePromptSnippet: "failure target=image_generate",
    ...overrides,
  });
}

async function runMockRuntimeToolFixtureWithOutputs(params: {
  toolName: string;
  happyArgs: Record<string, unknown>;
  failureArgs: Record<string, unknown>;
  happyOutput: string;
  failureOutput: string;
  happyPatchContents?: string | null;
}) {
  return runMockRuntimeToolFixture({
    toolName: params.toolName,
    requests: mockToolRequests(params),
    runAgentPrompt: vi.fn(async (runEnv, promptParams) =>
      params.toolName === "apply_patch"
        ? simulateRuntimePatchHappyTurn(runEnv, promptParams, params.happyPatchContents)
        : {},
    ),
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

    const result = runLiveRuntimeToolFixture(env, { runAgentPrompt });
    await expect(result).rejects.toBeInstanceOf(QaSuiteInfraError);
    await expect(result).rejects.toMatchObject({ code: "agent_wait_failed", cause: infraError });
    await expect(result).rejects.toThrow(
      [
        "RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:read:happy",
        "RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:read:failure",
        "failure prompt did not settle",
      ].join("\n"),
    );
  });

  it("skips Codex-native fixtures when only OpenClaw dynamic exposure evidence is absent", async () => {
    const env = await makeEnv({
      mock: { baseUrl: "http://127.0.0.1:9999" },
      gateway: {
        baseUrl: "http://127.0.0.1:1",
        tempRoot: "",
        workspaceDir: "",
        runtimeEnv: { OPENCLAW_QA_FORCE_RUNTIME: "codex" },
        call: vi.fn(),
      },
    });
    env.gateway.tempRoot = env.repoRoot;
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

    const transcriptToolNames: Array<string | undefined> = [];
    const runAgentPrompt = vi.fn(async (_env: unknown, params: { transcriptToolName?: string }) => {
      transcriptToolNames.push(params.transcriptToolName);
      return {};
    });
    await expect(
      runRuntimeToolFixture(
        env,
        {
          toolName: "read",
          toolCoverage: {
            bucket: "codex-native-workspace",
            expectedLayer: "codex-native-workspace",
            reason: "Codex owns read natively.",
          },
          promptSnippet: "target=read",
          failurePromptSnippet: "failure target=read",
        },
        {
          createSession: vi.fn(async (_env, _label, key) => key!),
          readEffectiveTools: vi.fn(async () => new Set<string>()),
          runAgentPrompt,
          fetchJson,
          ensureImageGenerationConfigured: vi.fn(),
        },
      ),
    ).rejects.toMatchObject({
      name: "QaSuiteScenarioSkipError",
      message: expect.stringMatching(
        /codex-native-workspace read[\s\S]*RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:read:happy[\s\S]*RUNTIME_PARITY_SESSION_KEY=agent:qa:runtime-tool:read:failure/u,
      ),
    });
    expect(runAgentPrompt).toHaveBeenCalledTimes(2);
    expect(transcriptToolNames).toEqual([undefined, undefined]);
  });

  it("rejects a native patch whose recorded working directory changes its target", async () => {
    const env = await makeEnv();
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
    await writeCodexNativePatchEvidence(env, "apply_patch failed: path escapes sandbox root", {
      happyArguments: {
        input: runtimePatchAddInput(),
        cwd: path.resolve(env.gateway.workspaceDir, ".."),
      },
    });

    await expect(runNativePatchFixture(env)).rejects.toThrow(
      "expected linked live apply_patch to add runtime-tool-fixture-patch.txt",
    );
  });

  it.each([
    {
      label: "native freeform patch text",
      encode: (input: string) => input,
    },
    {
      label: "JSON-encoded provider arguments",
      encode: (input: string) => JSON.stringify({ input }),
    },
    {
      label: "executed provider arguments with an empty mirrored input",
      encode: (input: string) => ({ input }),
      shadowInput: true,
    },
  ])("verifies linked $label without weakening workspace containment", async (testCase) => {
    const { encode } = testCase;
    const env = await makeEnv();
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
    await writeCodexNativePatchEvidence(env, "patch rejected: writing outside of the project", {
      happyArguments: encode(runtimePatchAddInput()),
      failureArguments: encode(runtimePatchUpdateInput()),
      ...("shadowInput" in testCase ? { happyInput: {}, failureInput: {} } : {}),
    });

    await expect(runNativePatchFixture(env)).resolves.toContain(
      "apply_patch live provider happy planned args",
    );

    await expect(
      fs.access(path.resolve(env.gateway.workspaceDir, "../runtime-tool-fixture-denied.txt")),
    ).rejects.toThrow();
  });

  it("recognizes native patch paths through a canonical workspace alias", async () => {
    const env = await makeEnv();
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
    const workspaceAlias = path.join(env.gateway.tempRoot, "workspace-alias");
    await fs.symlink(
      env.gateway.workspaceDir,
      workspaceAlias,
      process.platform === "win32" ? "junction" : "dir",
    );
    await writeCodexNativePatchEvidence(env, "apply_patch failed: path escapes sandbox root", {
      happyPath: path.join(workspaceAlias, "runtime-tool-fixture-patch.txt"),
    });

    await expect(runNativePatchFixture(env)).resolves.toContain(
      "apply_patch live provider happy planned args",
    );
  });

  it("does not accept assistant text as evidence of a native Codex workspace rejection", async () => {
    const env = await makeEnv();
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
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

    await expect(runNativePatchFixture(env)).rejects.toThrow(
      "expected live failure-path tool call for apply_patch",
    );

    await expect(
      fs.access(path.resolve(env.gateway.workspaceDir, "../runtime-tool-fixture-denied.txt")),
    ).rejects.toThrow();
  });

  it("verifies canonical absolute patch targets without a hunk marker", async () => {
    const env = await makeEnv();
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
    const happyPath = path.join(env.gateway.workspaceDir, "runtime-tool-fixture-patch.txt");
    const deniedPath = path.resolve(
      env.gateway.workspaceDir,
      "..",
      "runtime-tool-fixture-denied.txt",
    );
    await writeCodexNativePatchEvidence(env, "patch rejected: writing outside of the project", {
      happyArguments: {
        input: `*** Begin Patch\n*** Add File: ${happyPath}\n+runtime patch\n*** End Patch\n`,
      },
      failureArguments: {
        input: `*** Begin Patch\n*** Update File: ${deniedPath}\n-runtime-tool-fixture-denied-original\n+runtime patch outside the workspace\n*** End Patch\n`,
      },
    });

    await expect(runNativePatchFixture(env)).resolves.toContain(
      "apply_patch live provider happy planned args",
    );
  });

  it("rejects native patch transcripts that claim success without creating the workspace file", async () => {
    const env = await makeEnv();
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
    await writeCodexNativePatchEvidence(env);

    await expect(
      runNativePatchFixture(env, { runAgentPrompt: vi.fn(async () => ({})) }),
    ).rejects.toThrow(
      "expected apply_patch to create runtime-tool-fixture-patch.txt with exact contents",
    );
  });

  it("rejects native Codex patch failures that only report missing patch context", async () => {
    const env = await makeEnv();
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
    await writeCodexNativePatchEvidence(
      env,
      "apply_patch failed: failed to find expected lines in runtime-tool-fixture-denied.txt",
    );

    await expect(runNativePatchFixture(env)).rejects.toThrow(
      "expected live apply_patch failure to explicitly reject the workspace boundary",
    );
  });

  it("rejects native Codex patch failures without a linked failure result", async () => {
    const env = await makeEnv();
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
    await writeCodexNativePatchEvidence(env, "apply_patch completed", {
      failureStructuredError: false,
    });

    await expect(runNativePatchFixture(env)).rejects.toThrow(
      "expected live failure-path tool failure output for apply_patch",
    );
  });

  it("rejects linked native Codex patch evidence for the wrong failure-path operation", async () => {
    const env = await makeEnv();
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
    await writeCodexNativePatchEvidence(env, "apply_patch failed: path escapes sandbox root", {
      failureKind: "add",
    });

    await expect(runNativePatchFixture(env)).rejects.toThrow(
      "expected linked live apply_patch to update ../runtime-tool-fixture-denied.txt",
    );
  });

  it("validates the native patch call linked to its result instead of the first plan", async () => {
    const env = await makeEnv();
    env.gateway.runtimeEnv.OPENCLAW_QA_FORCE_RUNTIME = "codex";
    await writeQaSessionTranscript(env, "agent:qa:runtime-tool:apply_patch:happy", [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "native-patch-unlinked-decoy",
            name: "apply_patch",
            arguments: {
              changes: [{ path: "runtime-tool-fixture-wrong.txt", kind: { type: "add" } }],
            },
          },
        ],
      },
    ]);
    await writeCodexNativePatchEvidence(env);

    await expect(runNativePatchFixture(env)).resolves.toContain(
      "apply_patch live provider happy planned args",
    );
  });

  it("fails closed and cleans up when a patch changes the outside-workspace sentinel", async () => {
    const env = await makeEnv();
    const sentinelPath = path.resolve(
      env.gateway.workspaceDir,
      "../runtime-tool-fixture-denied.txt",
    );

    await expect(
      runLiveRuntimeToolFixture(env, {
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
    ).rejects.toThrow("apply_patch modified or removed the outside-workspace sentinel");

    await expect(fs.access(sentinelPath)).rejects.toThrow();
  });

  it("verifies native-only private-QA Codex patch calls without skipping them", async () => {
    const env = await makeEnv({ mock: { baseUrl: MOCK_BASE_URL } });
    const promptEvidence: Array<{
      requireSuccessfulTranscriptToolResult?: boolean;
      transcriptToolName?: string;
    }> = [];
    const details = await runMockRuntimeToolFixture({
      env,
      toolName: "apply_patch",
      requests: mockToolRequests({
        toolName: "apply_patch",
        happyArgs: { input: runtimePatchAddInput() },
        failureArgs: { input: runtimePatchUpdateInput() },
        happyOutput: "Successfully applied patch",
        failureOutput: "Error: Path escapes sandbox root",
        happyCallId: "private-qa-patch-happy",
        failureCallId: "private-qa-patch-failure",
      }),
      config: nativePatchFixtureConfig(),
      tools: [],
      forceCodex: true,
      runAgentPrompt: vi.fn(async (_env, params) => {
        promptEvidence.push({
          transcriptToolName: params.transcriptToolName,
          requireSuccessfulTranscriptToolResult: params.requireSuccessfulTranscriptToolResult,
        });
        return simulateRuntimePatchHappyTurn(_env, params);
      }),
    });

    expect(promptEvidence).toEqual([
      { transcriptToolName: undefined, requireSuccessfulTranscriptToolResult: undefined },
      { transcriptToolName: undefined, requireSuccessfulTranscriptToolResult: undefined },
    ]);
    expect(details).toContain("apply_patch mock provider happy planned args");
    expect(details).toContain("runtime-tool-fixture-patch.txt");
    expect(details).toContain("../runtime-tool-fixture-denied.txt");
    expect(details).not.toContain("codex-native-workspace apply_patch");
    await expect(
      fs.access(path.resolve(env.gateway.workspaceDir, "../runtime-tool-fixture-denied.txt")),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(env.gateway.workspaceDir, "runtime-tool-fixture-patch.txt")),
    ).rejects.toThrow();
  });

  it("rejects mock patch failures that only report missing patch context", async () => {
    await expect(
      runMockRuntimeToolFixtureWithOutputs({
        toolName: "apply_patch",
        happyArgs: {
          input: runtimePatchAddInput(),
        },
        failureArgs: {
          input: runtimePatchUpdateInput(),
        },
        happyOutput: "Successfully applied patch",
        failureOutput: "Error: failed to find expected lines in runtime-tool-fixture-denied.txt",
      }),
    ).rejects.toThrow(
      "expected mock apply_patch failure to explicitly reject the workspace boundary",
    );
  });

  it("rejects successful linked mock patch claims with no workspace mutation", async () => {
    await expect(
      runMockRuntimeToolFixtureWithOutputs({
        toolName: "apply_patch",
        happyArgs: {
          input: runtimePatchAddInput(),
        },
        failureArgs: {
          input: runtimePatchUpdateInput(),
        },
        happyOutput: "Successfully applied patch",
        failureOutput: "Error: Path escapes sandbox root",
        happyPatchContents: null,
      }),
    ).rejects.toThrow(
      "expected apply_patch to create runtime-tool-fixture-patch.txt with exact contents",
    );
  });

  it("skips Codex-native async planned-only fixtures without treating the plan as proof", async () => {
    await expect(
      runMockRuntimeToolFixture({
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
            bucket: "codex-native-workspace",
            expectedLayer: "codex-native-workspace",
            reason: "Codex owns image generation natively in this fixture.",
          },
          happyPathOutputRequired: false,
        }),
        tools: [],
        forceCodex: true,
      }),
    ).rejects.toThrow("image_generate mock provider report-only");
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
      {
        allInputText: "failure target=read",
        toolOutput: "ENOENT: no such file or directory",
      },
    ];

    await expect(runMockRuntimeToolFixture({ requests })).rejects.toThrow(
      "expected mock happy-path tool output for read",
    );
  });

  it("skips non-required mock fixtures when both paths are only planned", async () => {
    await expect(
      runMockRuntimeToolFixture({
        toolName: "image_generate",
        requests: mockToolRequests({
          toolName: "image_generate",
          happyArgs: { prompt: "QA lighthouse", filename: "runtime-tool-fixture" },
          failureArgs: { __qaFailureMode: "denied-input" },
          omitHappyOutput: true,
          omitFailureOutput: true,
        }),
        config: asyncImageFixtureConfig(),
      }),
    ).rejects.toThrow("image_generate mock provider report-only");
  });

  it("still rejects successful failure output for non-required mock fixtures", async () => {
    await expect(
      runMockRuntimeToolFixture({
        toolName: "image_generate",
        requests: mockToolRequests({
          toolName: "image_generate",
          happyArgs: { prompt: "QA lighthouse" },
          omitHappyOutput: true,
          failureArgs: { __qaFailureMode: "denied-input" },
          failureOutput: "Task queued for async image delivery",
        }),
        config: asyncImageFixtureConfig(),
      }),
    ).rejects.toThrow("expected mock failure-path tool failure output for image_generate");
  });

  it("rejects malformed report-only failure plans for non-required mock fixtures", async () => {
    await expect(
      runMockRuntimeToolFixture({
        toolName: "image_generate",
        requests: mockToolRequests({
          toolName: "image_generate",
          happyArgs: { prompt: "QA lighthouse" },
          failureArgs: { prompt: "not a denied-input failure" },
          omitHappyOutput: true,
          omitFailureOutput: true,
        }),
        config: asyncImageFixtureConfig(),
      }),
    ).rejects.toThrow("expected mock failure-path denied-input args for image_generate");
  });

  it("rejects malformed report-only happy plans for non-required mock fixtures", async () => {
    await expect(
      runMockRuntimeToolFixture({
        toolName: "image_generate",
        requests: mockToolRequests({
          toolName: "image_generate",
          happyArgs: {},
          failureArgs: { __qaFailureMode: "denied-input" },
          omitHappyOutput: true,
          omitFailureOutput: true,
        }),
        config: asyncImageFixtureConfig(),
      }),
    ).rejects.toThrow("expected mock happy-path prompt args for image_generate");
  });

  it("rejects unavailable-provider happy output as mock fixture output", async () => {
    await expect(
      runMockRuntimeToolFixtureWithOutputs({
        toolName: "web_search",
        happyArgs: { query: "OpenClaw runtime parity fixed query" },
        failureArgs: { __qaFailureMode: "denied-input" },
        happyOutput: "web_search is disabled or no provider is available.",
        failureOutput: "web_search is disabled or no provider is available.",
      }),
    ).rejects.toThrow("expected mock happy-path successful tool output for web_search");
  });
});

describe("runtime tool fixture known harness gaps", () => {
  it.each([
    { phase: "unavailable tool", tools: [], requests: [] },
    {
      phase: "missing failure output",
      requests: mockToolRequests({ omitFailureOutput: true }),
    },
    {
      phase: "successful failure output",
      requests: mockToolRequests({ failureOutput: "README contents" }),
    },
  ])("preserves an explicit known harness gap for $phase", async ({ requests, ...fixture }) => {
    await expect(
      runMockRuntimeToolFixture({
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
});

describe("runtime tool fixture mock request linking", () => {
  it("validates the linked mock patch after an unlinked plan", async () => {
    const requests = mockToolRequests({
      toolName: "apply_patch",
      happyArgs: { input: runtimePatchAddInput() },
      failureArgs: { input: runtimePatchUpdateInput() },
      happyOutput: "Successfully applied patch",
      failureOutput: "Error: Path escapes sandbox root",
    });
    await expect(
      runMockRuntimeToolFixture({
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
    await expect(
      runMockRuntimeToolFixture({
        requests: [
          {
            ...requests[0],
            toolOutputCallId: "call-write-previous",
            toolOutput: "previous write output",
          },
          ...requests.slice(2),
        ],
      }),
    ).rejects.toThrow("expected mock happy-path tool output for read");
  });
  it.each([
    ["happy-path file", runtimePatchAddInput("runtime-tool-fixture-wrong.txt"), undefined],
    [
      "failure-path replacement",
      undefined,
      runtimePatchUpdateInput().replace(
        "+runtime patch outside the workspace",
        "+incorrect replacement",
      ),
    ],
  ])(
    "rejects linked mock patch evidence for the wrong %s",
    async (_label, happyInput, failureInput) => {
      await expect(
        runMockRuntimeToolFixture({
          toolName: "apply_patch",
          requests: mockToolRequests({
            toolName: "apply_patch",
            happyArgs: { input: happyInput ?? runtimePatchAddInput() },
            failureArgs: { input: failureInput ?? runtimePatchUpdateInput() },
            happyOutput: "Successfully applied patch",
            failureOutput: "Error: Path escapes sandbox root",
          }),
          runAgentPrompt: vi.fn(simulateRuntimePatchHappyTurn),
        }),
      ).rejects.toThrow(
        happyInput
          ? "expected linked mock apply_patch to add runtime-tool-fixture-patch.txt"
          : "expected linked mock apply_patch to update ../runtime-tool-fixture-denied.txt",
      );
    },
  );
});

describe("nested runtime tool fixture", () => {
  it.each(["correlated success and error", "missing nested result"])(
    "validates nested runtime evidence: %s",
    async (testCase) => {
      const missingResult = testCase === "missing nested result";
      const env = await makeEnv();
      const receipt = (phase: "happy" | "failure") => {
        const params = {
          toolName: "web_fetch",
          toolCallId: `nested-${phase}`,
          input: { url: phase === "happy" ? "https://example.com/" : "file:///denied" },
          text: "completed",
          isError: phase === "failure",
        };
        const activity = nestedToolActivityFixture(params);
        return {
          ...activity,
          details: {
            ...activity.details,
            result: missingResult ? undefined : activity.details.result,
          },
        };
      };
      await writeRuntimeToolTranscripts(
        env,
        "web_fetch",
        [
          ...(!missingResult
            ? [
                {
                  role: "toolResult",
                  toolName: "unrelated",
                  toolCallId: "nested-happy",
                  isError: true,
                  content: "failed unrelated tool",
                },
              ]
            : []),
          receipt("happy"),
        ],
        [receipt("failure")],
      );
      const result = runRuntimeToolFixture(
        env,
        runtimeToolFixtureConfig("web_fetch"),
        runtimeToolFixtureDeps({ tools: ["web_fetch"] }),
      );
      if (missingResult) {
        await expect(result).rejects.toThrow("expected live happy-path tool call for web_fetch");
      } else {
        await expect(result).resolves.toContain('"url":"https://example.com/"');
      }
    },
  );
});

async function runTranscriptFixture(
  happyMessages: Array<Record<string, unknown>>,
  {
    toolName = "read",
    failureMessages,
    asyncOutput = false,
  }: {
    toolName?: string;
    failureMessages?: Array<Record<string, unknown>>;
    asyncOutput?: boolean;
  } = {},
) {
  const env = await makeEnv();
  await writeRuntimeToolTranscripts(
    env,
    toolName,
    happyMessages,
    failureMessages ?? [
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
    ],
  );
  return runLiveRuntimeToolFixture(env, {
    toolName,
    ...(asyncOutput
      ? { config: runtimeToolFixtureConfig(toolName, { happyPathOutputRequired: false }) }
      : {}),
  });
}

describe("runtime tool fixture transcript evidence", () => {
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
      await expect(runTranscriptFixture(happyMessages, { toolName })).rejects.toThrow(
        expectedError,
      );
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

      await expect(runLiveRuntimeToolFixture(env)).resolves.toContain(JSON.stringify(happyArgs));
    },
  );

  it("skips async live runtime tool fixtures when the happy path has no result", async () => {
    await expect(
      runTranscriptFixture(
        [
          transcriptToolCall("image_generate", "happy", {
            prompt: "QA lighthouse runtime parity fixture",
          }),
        ],
        { toolName: "image_generate", asyncOutput: true },
      ),
    ).rejects.toThrow("planned call without a linked successful result");
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildCodeModeMatrixAgentExecArgs,
  prepareCodeModeMatrixTaskFixture,
  runCodeModeModelMatrix,
} from "../../../scripts/code-mode-model-matrix.ts";
import { validFrontierCellResult } from "./code-mode-model-matrix.test-helpers.js";

const profileId = "openai:matrix";
const credentialEnvName = "OPENAI_API_KEY";

function config(extra = "", model = "gpt-5.6"): string {
  return `{
    agents: {
      defaults: {
        model: { primary: "openai/${model}@${profileId}", fallbacks: [] },
        models: {
          "openai/${model}": { agentRuntime: { id: "openclaw" } },
        },
      },
    },
    auth: {
      profiles: {
        "${profileId}": { provider: "openai", mode: "api_key" },
      },
    },
    ${extra}
  }\n`;
}

const sourceIdentity = async () => ({
  gitSha: "abc123",
  sourceDirty: false,
  sourcePatchSha256: null,
});

const validAuthProfile = async () => ({
  credentialEnvName,
  credentialValue: "sk-admitted",
  mode: "api_key" as const,
  present: true,
  provider: "openai",
});

async function runBlocked(params: {
  configText: string;
  model?: string;
  modes?: Array<"direct" | "auto" | "code">;
  readAuthProfile?: () => Promise<{
    credentialEnvName?: string;
    credentialValue?: string;
    mode?: "api_key";
    present: boolean;
    provider?: string;
  }>;
  thinking?: string;
}): Promise<unknown> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-matrix-preflight-"));
  try {
    const configPath = path.join(repoRoot, "matrix.json5");
    await fs.writeFile(configPath, params.configText, "utf8");
    const result = await runCodeModeModelMatrix(
      {
        allowFailures: true,
        conversationProof: true,
        config: configPath,
        dryRun: true,
        keepState: false,
        models: [`openai/${params.model ?? "gpt-5.6"}`],
        modes: params.modes ?? ["direct", "code"],
        outputDir: "artifacts",
        repetitions: 2,
        repoRoot,
        tasks: ["dependent-read-write"],
        thinking: params.thinking ?? "high",
        timeoutSeconds: 10,
      },
      {
        readAuthProfile: params.readAuthProfile ?? validAuthProfile,
        readSourceIdentity: sourceIdentity,
      },
    );
    expect(await fs.readFile(path.join(repoRoot, "artifacts", "results.jsonl"), "utf8")).toBe("");
    return result.summary;
  } finally {
    await fs.rm(repoRoot, { recursive: true, force: true });
  }
}

describe("Code Mode frontier matrix preflight", () => {
  it("runs the documented Ollama diagnostic without frontier preflight", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-matrix-diagnostic-"));
    const readAuthProfile = vi.fn();
    const runConversationProof = vi.fn();
    const runCell = vi.fn(async (params) => {
      expect(params.frontierEvidencePolicy).toBeUndefined();
      expect(params.frontierEvidenceRunNonce).toBeUndefined();
      expect(params.frozenEnv.OLLAMA_API_KEY).toBe("ollama-local");
      expect(
        buildCodeModeMatrixAgentExecArgs({
          fixture: { prompt: "verify" },
          matrix: params,
          runtime: { args: ["/runtime/dist/entry.js"], cwd: "/runtime" },
          stateDir: "/state",
          workspace: "/workspace",
        }),
      ).toContain("--local-model-lean");
      const fixture = await prepareCodeModeMatrixTaskFixture(
        path.join(params.campaignRoot, params.cell.id),
        params.cell,
      );
      return {
        buildSha256: params.buildSha256,
        codeModeEngaged: true,
        configSha256: params.configSha256,
        elapsedMs: 10,
        expected: fixture.expected,
        failureCategory: null,
        final: fixture.expected,
        firstLogicalCallCacheStatus: "unknown" as const,
        fixtureSha256: fixture.fixtureSha256,
        gitSha: params.gitSha,
        id: params.cell.id,
        mode: params.cell.mode,
        model: params.cell.model,
        observedModel: "qwen3.5:9b",
        observedProvider: "ollama",
        oracle: {
          answer: true,
          effect: true,
          engagement: true,
          identity: true,
          toolExecution: true,
        },
        passed: true,
        promptSha256: fixture.promptSha256,
        repetition: params.cell.repetition,
        sourceDirty: params.sourceDirty,
        sourcePatchSha256: params.sourcePatchSha256,
        status: "ok" as const,
        task: params.cell.task,
        timestamp: "2026-08-07T00:00:00.000Z",
        workspaceIdentitySha256: fixture.workspaceIdentitySha256,
        workspaceSeedSha256: fixture.workspaceSeedSha256,
      };
    });
    try {
      const result = await runCodeModeModelMatrix(
        {
          allowFailures: false,
          conversationProof: false,
          dryRun: false,
          keepState: false,
          models: ["ollama/qwen3.5:9b"],
          modes: ["code"],
          outputDir: "artifacts",
          repetitions: 1,
          repoRoot,
          tasks: ["read"],
          thinking: "off",
          timeoutSeconds: 10,
        },
        {
          buildCliArtifacts: async () => {},
          readAuthProfile,
          readBuildSha256: async () => "build123",
          readSourceIdentity: sourceIdentity,
          runCell,
          runConversationProof,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(runCell).toHaveBeenCalledOnce();
      expect(readAuthProfile).not.toHaveBeenCalled();
      expect(runConversationProof).not.toHaveBeenCalled();
      expect(result.summary).toMatchObject({
        status: "complete",
        evidenceClass: "diagnostic_only",
        qualification: {
          state: "diagnostic_only",
          betaRecommendation: "not_eligible",
          reason: "conversation_proof_not_requested",
        },
        counts: { total: 1, passed: 1, failed: 0 },
      });
      expect(result.summary).not.toHaveProperty("executionPolicy");
      expect(result.summary).not.toHaveProperty("frontierEvidenceAudit");
      expect(result.summary).not.toHaveProperty("betaGate");
      const evidence = JSON.parse(
        await fs.readFile(path.join(repoRoot, "artifacts", "qa-evidence.json"), "utf8"),
      ) as {
        entries: Array<{
          evidenceClass?: string;
          execution?: { provider?: { auth?: string; fixture?: string; live?: boolean } };
        }>;
      };
      expect(evidence.entries[0]?.evidenceClass).toBe("diagnostic_only");
      expect(evidence.entries[0]?.execution?.provider).toMatchObject({
        live: false,
      });
      expect(evidence.entries[0]?.execution?.provider).not.toHaveProperty("auth");
      expect(evidence.entries[0]?.execution?.provider).not.toHaveProperty("fixture");
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it.each([
    ["ollama/qwen3.5:9b", "ollama", "https://ollama.example/v1", "ollama"],
    ["lmstudio/qwen3.5:9b", "lmstudio", "https://lmstudio.example/v1", "openai-completions"],
  ])(
    "uses the pinned remote config when classifying diagnostic route %s",
    async (model, provider, baseUrl, api) => {
      const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-matrix-remote-"));
      const previousOllamaApiKey = process.env.OLLAMA_API_KEY;
      delete process.env.OLLAMA_API_KEY;
      const configPath = path.join(repoRoot, "matrix.json5");
      await fs.writeFile(
        configPath,
        JSON.stringify({
          models: {
            providers: {
              [provider]: {
                api,
                baseUrl,
                models: [],
              },
            },
          },
        }),
        "utf8",
      );
      const runCell = vi.fn(async (params) => {
        expect(params.config).toMatchObject({
          models: { providers: { [provider]: { baseUrl } } },
        });
        expect(params.frozenEnv.OLLAMA_API_KEY).toBeUndefined();
        expect(
          buildCodeModeMatrixAgentExecArgs({
            configPath,
            fixture: { prompt: "verify" },
            matrix: params,
            runtime: { args: ["/runtime/dist/entry.js"], cwd: "/runtime" },
            stateDir: "/state",
            workspace: "/workspace",
          }),
        ).not.toContain("--local-model-lean");
        const fixture = await prepareCodeModeMatrixTaskFixture(
          path.join(params.campaignRoot, params.cell.id),
          params.cell,
        );
        return {
          buildSha256: params.buildSha256,
          codeModeEngaged: true,
          configSha256: params.configSha256,
          elapsedMs: 10,
          expected: fixture.expected,
          failureCategory: null,
          final: fixture.expected,
          firstLogicalCallCacheStatus: "unknown" as const,
          fixtureSha256: fixture.fixtureSha256,
          gitSha: params.gitSha,
          id: params.cell.id,
          mode: params.cell.mode,
          model: params.cell.model,
          observedModel: params.cell.model.split("/").slice(1).join("/"),
          observedProvider: provider,
          oracle: {
            answer: true,
            effect: true,
            engagement: true,
            identity: true,
            toolExecution: true,
          },
          passed: true,
          promptSha256: fixture.promptSha256,
          repetition: params.cell.repetition,
          sourceDirty: params.sourceDirty,
          sourcePatchSha256: params.sourcePatchSha256,
          status: "ok" as const,
          task: params.cell.task,
          timestamp: "2026-08-07T00:00:00.000Z",
          workspaceIdentitySha256: fixture.workspaceIdentitySha256,
          workspaceSeedSha256: fixture.workspaceSeedSha256,
        };
      });
      try {
        const result = await runCodeModeModelMatrix(
          {
            allowFailures: false,
            config: configPath,
            conversationProof: false,
            dryRun: false,
            keepState: false,
            models: [model],
            modes: ["code"],
            outputDir: "artifacts",
            repetitions: 1,
            repoRoot,
            tasks: ["read"],
            thinking: "off",
            timeoutSeconds: 10,
          },
          {
            buildCliArtifacts: async () => {},
            readBuildSha256: async () => "build123",
            readSourceIdentity: sourceIdentity,
            runCell,
          },
        );

        expect(result.exitCode).toBe(0);
        expect(runCell).toHaveBeenCalledOnce();
      } finally {
        if (previousOllamaApiKey === undefined) {
          delete process.env.OLLAMA_API_KEY;
        } else {
          process.env.OLLAMA_API_KEY = previousOllamaApiKey;
        }
        await fs.rm(repoRoot, { recursive: true, force: true });
      }
    },
  );

  it("blocks an allowlisted model without catalog Code Mode support before any work", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-matrix-model-scope-"));
    try {
      const configPath = path.join(repoRoot, "matrix.json5");
      await fs.writeFile(configPath, config("", "gpt-5.4"), "utf8");
      const buildCliArtifacts = vi.fn();
      const runCell = vi.fn();
      const runConversationProof = vi.fn();
      const result = await runCodeModeModelMatrix(
        {
          allowFailures: false,
          conversationProof: true,
          config: configPath,
          dryRun: false,
          keepState: false,
          models: ["openai/gpt-5.4"],
          modes: ["direct", "code"],
          outputDir: "artifacts",
          repetitions: 2,
          repoRoot,
          tasks: ["dependent-read-write"],
          thinking: "high",
          timeoutSeconds: 600,
        },
        {
          buildCliArtifacts,
          readAuthProfile: validAuthProfile,
          readSourceIdentity: sourceIdentity,
          runCell,
          runConversationProof,
        },
      );

      expect(result.summary).toMatchObject({
        status: "blocked",
        blockedReasons: ["frontier_model_code_mode_unsupported"],
        qualification: {
          state: "not_eligible",
          reason: "code_mode_capability_unattested",
        },
      });
      expect(buildCliArtifacts).not.toHaveBeenCalled();
      expect(runCell).not.toHaveBeenCalled();
      expect(runConversationProof).not.toHaveBeenCalled();
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });

  it.each(["off", "medium", "xhigh"])(
    "rejects a %s-thinking frontier comparison",
    async (thinking) => {
      await expect(runBlocked({ configText: config(), thinking })).resolves.toMatchObject({
        status: "blocked",
        cellsExecuted: 0,
        blockedReasons: expect.arrayContaining(["thinking_level_not_comparable"]),
      });
    },
  );

  it.each([
    ["config_runtime_env_present", config('env: { vars: { OPENAI_BASE_URL: "x" } },')],
    ["config_shell_env_enabled", config("env: { shellEnv: { enabled: true } },")],
    [
      "config_env_substitution_present",
      config('models: { providers: { openai: { baseUrl: "${OPENAI_BASE_URL}" } } },'),
    ],
  ])("blocks %s before any cell", async (code, configText) => {
    await expect(runBlocked({ configText })).resolves.toMatchObject({
      status: "blocked",
      cellsExecuted: 0,
      blockedReasons: [code],
    });
  });

  it("rejects a non-ABBA frontier schedule", async () => {
    await expect(
      runBlocked({ configText: config(), modes: ["direct", "auto", "code"] }),
    ).resolves.toMatchObject({
      status: "blocked",
      cellsExecuted: 0,
      blockedReasons: expect.arrayContaining(["frontier_schedule_invalid"]),
    });
  });

  it("rejects credentials that are not canonical env keyRefs", async () => {
    await expect(
      runBlocked({
        configText: config(),
        readAuthProfile: async () => ({
          mode: "api_key",
          present: true,
          provider: "openai",
        }),
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      cellsExecuted: 0,
      blockedReasons: ["auth_profile_not_env_keyref", "credential_environment_missing"],
    });
  });

  it("rejects a noncanonical credential environment before any cell", async () => {
    await expect(
      runBlocked({
        configText: config(),
        readAuthProfile: async () => ({
          credentialEnvName: "NODE_OPTIONS",
          credentialValue: "--import=/tmp/not-allowed.mjs",
          mode: "api_key",
          present: true,
          provider: "openai",
        }),
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      cellsExecuted: 0,
      blockedReasons: ["auth_profile_not_env_keyref"],
    });
  });

  it("keeps auth store failures distinct from config failures", async () => {
    await expect(
      runBlocked({
        configText: config(),
        readAuthProfile: async () => {
          throw new Error("credential store unreadable");
        },
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      cellsExecuted: 0,
      blockedReasons: ["auth_profile_read_failed"],
    });
  });

  it.each([
    ["provider api key", config('models: { providers: { openai: { apiKey: "secret-marker" } } },')],
    ["provider timeout", config("models: { providers: { openai: { timeoutSeconds: 30 } } },")],
    [
      "provider token metadata",
      config(
        "models: { providers: { openai: { contextWindow: 200000, contextTokens: 180000, maxTokens: 64000 } } },",
      ),
    ],
    [
      "provider model metadata",
      config(
        'models: { providers: { openai: { models: [{ id: "gpt-5.6", name: "custom", contextWindow: 200000, maxTokens: 64000, compat: {} }] } } },',
      ),
    ],
    [
      "agent model streaming",
      config().replace(
        '{ agentRuntime: { id: "openclaw" } }',
        '{ agentRuntime: { id: "openclaw" }, streaming: false }',
      ),
    ],
  ])("rejects authored selected-route metadata: %s", async (_name, configText) => {
    await expect(runBlocked({ configText })).resolves.toMatchObject({
      status: "blocked",
      cellsExecuted: 0,
      blockedReasons: expect.arrayContaining(["selected_route_override_present"]),
    });
  });

  it("reuses the admitted credential value for every cell and removes the policy file", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-matrix-frozen-env-"));
    let authReads = 0;
    let clock = 0;
    let policyPath: string | undefined;
    let policyText: string | undefined;
    const observedCredentials: Array<string | undefined> = [];
    try {
      const configPath = path.join(repoRoot, "matrix.json5");
      await fs.writeFile(configPath, config(), "utf8");
      const result = await runCodeModeModelMatrix(
        {
          allowFailures: true,
          conversationProof: true,
          config: configPath,
          dryRun: false,
          keepState: false,
          models: ["openai/gpt-5.6"],
          modes: ["direct", "code"],
          outputDir: "artifacts",
          repetitions: 2,
          repoRoot,
          tasks: ["dependent-read-write"],
          thinking: "high",
          timeoutSeconds: 10,
        },
        {
          buildCliArtifacts: async () => {},
          nowMs: () => {
            clock += 10;
            return clock;
          },
          readAuthProfile: async () => {
            authReads += 1;
            return {
              credentialEnvName,
              credentialValue: authReads === 1 ? "sk-admitted" : "sk-mutated",
              mode: "api_key",
              present: true,
              provider: "openai",
            };
          },
          readBuildSha256: async () => "build123",
          readSourceIdentity: sourceIdentity,
          runConversationProof: async () => ({
            status: "blocked",
            blockedReasons: ["test_sidecar_not_run"],
          }),
          runCell: async (params) => {
            observedCredentials.push(params.frozenEnv[credentialEnvName]);
            policyPath = params.frontierEvidencePolicy?.path;
            policyText = policyPath ? await fs.readFile(policyPath, "utf8") : undefined;
            return await validFrontierCellResult(params);
          },
        },
      );
      expect(result.exitCode).toBe(1);
      expect(observedCredentials).toEqual([
        "sk-admitted",
        "sk-admitted",
        "sk-admitted",
        "sk-admitted",
      ]);
      expect(policyPath).toBeDefined();
      expect(policyText).not.toContain(profileId);
      expect(JSON.parse(policyText ?? "{}")).toMatchObject({
        authBindingId: expect.stringMatching(/^[a-f0-9]{32}$/u),
      });
      await expect(fs.stat(policyPath!)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await fs.rm(repoRoot, { recursive: true, force: true });
    }
  });
});

// Code Mode model matrix tests cover repeatable small-model acceptance evidence.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCodeModeMatrixCells,
  classifyCodeModeMatrixCell,
  modelCellPrefix,
  parseCodeModeMatrixOptions,
  prepareCodeModeMatrixTaskFixture,
  reserveCodeModeMatrixOutputDir,
  resolveCodeModeMatrixOutputDir,
  runCodeModeModelMatrix,
  type CodeModeMatrixCellResult,
} from "../../../scripts/code-mode-model-matrix.ts";

const frozenConfig = `{
  agents: {
    defaults: {
      model: { primary: "openai/gpt-5.4@openai:matrix", fallbacks: [] },
      models: {
        "openai/gpt-5.4": { agentRuntime: { id: "openclaw" } },
      },
    },
  },
  auth: {
    profiles: {
      "openai:matrix": { provider: "openai", mode: "api_key" },
    },
  },
}\n`;

const matrixAuthProfile = async (_params: { profileId: string }) => ({
  credentialEnvName: "OPENAI_API_KEY",
  credentialValue: "sk-matrix-test",
  mode: "api_key" as const,
  present: true,
  provider: "openai",
});

describe("Code Mode model matrix options", () => {
  it("defaults to the paired frontier matrix", () => {
    expect(parseCodeModeMatrixOptions(["--model", "ollama/qwen3.5:9b"], "/repo")).toMatchObject({
      conversationProof: false,
      models: ["ollama/qwen3.5:9b"],
      modes: ["direct", "code"],
      tasks: ["read", "dependent-read-write"],
      repetitions: 2,
      timeoutSeconds: 180,
      thinking: "off",
      repoRoot: "/repo",
    });
  });

  it("rejects ambiguous selectors and output paths", () => {
    expect(() => parseCodeModeMatrixOptions([])).toThrow("Exactly one --model");
    expect(() => parseCodeModeMatrixOptions(["--model", "qwen3.5:9b"])).toThrow("provider/model");
    expect(() =>
      parseCodeModeMatrixOptions(["--model", "ollama/qwen3.5:9b", "--skip-build"]),
    ).toThrow("Unknown argument");
    expect(() =>
      parseCodeModeMatrixOptions(["--model", "ollama/qwen3.5:9b", "--model", "openai/gpt-5.4"]),
    ).toThrow("Exactly one --model");
    expect(() =>
      parseCodeModeMatrixOptions([
        "--model",
        "ollama/qwen3.5:9b",
        "--mode",
        "code",
        "--mode",
        "code",
      ]),
    ).toThrow("Duplicate --mode");
    expect(() =>
      resolveCodeModeMatrixOutputDir("/repo", "../outside", new Date("2026-07-28T12:00:00Z")),
    ).toThrow("within the repository");
    expect(() =>
      resolveCodeModeMatrixOutputDir("/repo", "/tmp/out", new Date("2026-07-28T12:00:00Z")),
    ).toThrow("repo-relative");
    expect(() =>
      resolveCodeModeMatrixOutputDir("/repo", ".", new Date("2026-07-28T12:00:00Z")),
    ).toThrow("within the repository");
  });

  it("resolves an explicit frozen config path", () => {
    expect(
      parseCodeModeMatrixOptions(["--model", "openai/gpt-5.4", "--config", "matrix.json5"], "/repo")
        .config,
    ).toBe(path.resolve("/repo", "matrix.json5"));
  });

  it("keeps the real model selector when conversation proof is enabled", () => {
    expect(
      parseCodeModeMatrixOptions(["--model", "openai/gpt-5.4", "--conversation-proof"], "/repo"),
    ).toMatchObject({
      conversationProof: true,
      models: ["openai/gpt-5.4"],
    });
    expect(() => parseCodeModeMatrixOptions(["--conversation-proof"], "/repo")).toThrow(
      "Exactly one --model",
    );
  });

  it("reserves a fresh output path without symlink traversal", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-output-test-"));
    try {
      const existing = path.join(repoRoot, "existing");
      await fs.mkdir(existing);
      await expect(reserveCodeModeMatrixOutputDir(repoRoot, existing)).rejects.toThrow(
        "must not already exist",
      );

      const outside = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-outside-test-"));
      const linked = path.join(repoRoot, "linked");
      await fs.symlink(outside, linked, process.platform === "win32" ? "junction" : "dir");
      await expect(
        reserveCodeModeMatrixOutputDir(repoRoot, path.join(linked, "results")),
      ).rejects.toThrow("must not traverse symlinks");
      await fs.rm(outside, { force: true, recursive: true });
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });

  it("allows only one concurrent run to reserve an output path", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-reserve-test-"));
    try {
      const outputDir = path.join(repoRoot, "nested", "results");
      const attempts = await Promise.allSettled([
        reserveCodeModeMatrixOutputDir(repoRoot, outputDir),
        reserveCodeModeMatrixOutputDir(repoRoot, outputDir),
      ]);

      expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
      const rejected = attempts.find((attempt) => attempt.status === "rejected");
      expect(rejected).toMatchObject({
        status: "rejected",
        reason: expect.objectContaining({
          message: expect.stringContaining("must not already exist"),
        }),
      });
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });
});

describe("Code Mode model matrix identity", () => {
  it("keeps punctuation variants distinct", () => {
    expect(modelCellPrefix("ollama/foo.bar")).not.toBe(modelCellPrefix("ollama/foo-bar"));
  });

  it("orders the paired diagnostic Direct1, Code1, Code2, Direct2", () => {
    const cells = buildCodeModeMatrixCells({
      allowFailures: false,
      conversationProof: false,
      dryRun: true,
      keepState: false,
      models: ["openai/gpt-5.4"],
      modes: ["direct", "code"],
      repetitions: 2,
      repoRoot: "/repo",
      tasks: ["read"],
      thinking: "high",
      timeoutSeconds: 600,
    });

    expect(cells.map(({ mode, repetition }) => `${mode}-${repetition}`)).toEqual([
      "direct-1",
      "code-1",
      "code-2",
      "direct-2",
    ]);
  });

  it("keeps fixture and prompt bytes identical across paired modes and repetitions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-fixture-test-"));
    try {
      const cells = buildCodeModeMatrixCells({
        allowFailures: false,
        conversationProof: false,
        dryRun: true,
        keepState: false,
        models: ["openai/gpt-5.4"],
        modes: ["direct", "code"],
        repetitions: 2,
        repoRoot: "/repo",
        tasks: ["dependent-read-write"],
        thinking: "high",
        timeoutSeconds: 600,
      });
      const fixtures = await Promise.all(
        cells.map((cell, index) =>
          prepareCodeModeMatrixTaskFixture(path.join(root, String(index)), cell),
        ),
      );

      expect(new Set(fixtures.map((fixture) => fixture.fixtureSha256)).size).toBe(1);
      expect(new Set(fixtures.map((fixture) => fixture.promptSha256)).size).toBe(1);
      expect(new Set(fixtures.map((fixture) => fixture.expected)).size).toBe(1);
      expect(new Set(fixtures.map((fixture) => fixture.workspaceSeedSha256)).size).toBe(1);
      expect(new Set(fixtures.map((fixture) => fixture.workspaceIdentitySha256)).size).toBe(4);

      const repeatedWorkspace = path.join(root, "repeated");
      const first = await prepareCodeModeMatrixTaskFixture(repeatedWorkspace, cells[0]!);
      await fs.mkdir(path.join(repeatedWorkspace, "poison"), { recursive: true });
      await fs.writeFile(path.join(repeatedWorkspace, "result.txt"), "stale", "utf8");
      await fs.writeFile(path.join(repeatedWorkspace, "poison", "nested.txt"), "stale", "utf8");
      const second = await prepareCodeModeMatrixTaskFixture(repeatedWorkspace, cells[0]!);
      expect(second).toMatchObject({
        workspaceIdentitySha256: first.workspaceIdentitySha256,
        workspaceSeedSha256: first.workspaceSeedSha256,
      });
      expect(await fs.readdir(repeatedWorkspace)).toEqual(["facts.txt"]);
    } finally {
      await fs.rm(root, { force: true, recursive: true });
    }
  });
});

describe("Code Mode model matrix classification", () => {
  const successEnvelope = {
    ok: true,
    status: "ok",
    final: "CM-EXPECTED",
    payloads: [{ text: "CM-EXPECTED" }],
    codeModeEngaged: true,
    bridgeCalls: { search: 0, describe: 0, call: 1 },
    toolSummary: { calls: 1, tools: ["exec"] },
    model: "qwen3.5:9b",
    provider: "ollama",
    sessionId: "session",
  } satisfies Parameters<typeof classifyCodeModeMatrixCell>[0]["envelope"];

  it("requires engagement, tool execution, effect, and exact final text", () => {
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "",
        effectPassed: true,
        envelope: successEnvelope,
        expected: "CM-EXPECTED",
        mode: "code",
        model: "ollama/qwen3.5:9b",
        task: "read",
      }),
    ).toEqual({
      failureCategory: null,
      passed: true,
      oracle: {
        answer: true,
        effect: true,
        engagement: true,
        identity: true,
        toolExecution: true,
      },
    });
  });

  it("keeps provider failures distinct from model task failures", () => {
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "HTTP 402 payment required",
        effectPassed: false,
        envelope: {
          ...successEnvelope,
          ok: false,
          status: "error",
          final: "",
          error: { kind: "error_payload", message: "credits depleted" },
        },
        expected: "CM-EXPECTED",
        mode: "code",
        model: "ollama/qwen3.5:9b",
        task: "read",
      }).failureCategory,
    ).toBe("provider_billing");
  });

  it.each([
    "The selected model was not found by the provider. Check the model id or choose a different model.",
    'HTTP 404: {"code":"model_not_found"}',
    "HTTP 400: model-unavailable",
    "HTTP 404: model gpt-5.4 not found",
    "HTTP 400: requested model is unavailable",
    "HTTP 404: you do not have access to the requested model",
  ])("classifies terminal model-access errors: %s", (message) => {
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "",
        effectPassed: false,
        envelope: {
          ...successEnvelope,
          ok: false,
          status: "error",
          final: "",
          error: { kind: "error_payload", message },
        },
        expected: "CM-EXPECTED",
        mode: "code",
        model: "openai/gpt-5.4",
        task: "read",
      }).failureCategory,
    ).toBe("provider_model_access");
  });

  it.each([
    ["raw status only", "HTTP 404", "", "agent_error"],
    ["diagnostics only", "run failed", "HTTP 404: requested model is unavailable", "agent_error"],
    ["generic fixture miss", "HTTP 404: model output fixture not found", "", "agent_error"],
    ["documentation path", "HTTP 404: docs/model-card/gpt-5.4 not found", "", "agent_error"],
    ["wrong status", "HTTP 500: requested model is unavailable", "", "provider_transport"],
    ["different model", "HTTP 404: other-model not found", "", "agent_error"],
    [
      "unrelated property miss",
      "HTTP 400 request for model gpt-5.4: tool property not found",
      "",
      "agent_error",
    ],
    [
      "unrelated service availability",
      "HTTP 404 request for model gpt-5.4: tool service unavailable",
      "",
      "agent_error",
    ],
  ])(
    "does not infer model access from %s",
    (_name, message, diagnostics, expectedFailureCategory) => {
      expect(
        classifyCodeModeMatrixCell({
          diagnostics,
          effectPassed: false,
          envelope: {
            ...successEnvelope,
            ok: false,
            status: "error",
            final: "",
            error: { kind: "agent_error", message },
          },
          expected: "CM-EXPECTED",
          mode: "code",
          model: "openai/gpt-5.4",
          task: "read",
        }).failureCategory,
      ).toBe(expectedFailureCategory);
    },
  );

  it("does not infer model access from successful task output", () => {
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "",
        effectPassed: true,
        envelope: {
          ...successEnvelope,
          final: "HTTP 404: requested model is unavailable",
          model: "gpt-5.4",
          provider: "openai",
        },
        expected: "HTTP 404: requested model is unavailable",
        mode: "code",
        model: "openai/gpt-5.4",
        task: "read",
      }).failureCategory,
    ).toBeNull();
  });

  it("does not fail a successful run because diagnostics mention a recovered provider error", () => {
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "recovered after a transient network socket error",
        effectPassed: true,
        envelope: successEnvelope,
        expected: "CM-EXPECTED",
        mode: "code",
        model: "ollama/qwen3.5:9b",
        task: "read",
      }).failureCategory,
    ).toBeNull();
  });

  it("fails a successful envelope when JSON stdout has trailing output", () => {
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "unexpected stdout after JSON: noisy log",
        effectPassed: true,
        envelope: successEnvelope,
        expected: "CM-EXPECTED",
        mode: "code",
        model: "ollama/qwen3.5:9b",
        stdoutContractValid: false,
        task: "read",
      }).failureCategory,
    ).toBe("harness_error");
  });

  it("classifies a direct read with extra prose as an answer mismatch", () => {
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "",
        effectPassed: true,
        envelope: {
          ...successEnvelope,
          bridgeCalls: { search: 0, describe: 0, call: 0 },
          codeModeEngaged: false,
          final: "The value is CM-EXPECTED.",
        },
        expected: "CM-EXPECTED",
        mode: "direct",
        model: "ollama/qwen3.5:9b",
        task: "read",
      }),
    ).toMatchObject({
      failureCategory: "answer_mismatch",
      oracle: { answer: false, toolExecution: true },
    });
  });

  it("requires outer tool-call evidence for direct and automatic cells", () => {
    for (const mode of ["direct", "auto"] as const) {
      expect(
        classifyCodeModeMatrixCell({
          diagnostics: "",
          effectPassed: true,
          envelope: {
            ...successEnvelope,
            codeModeEngaged: mode === "auto",
            toolSummary: { calls: 0, tools: [] },
          },
          expected: "CM-EXPECTED",
          mode,
          model: "ollama/qwen3.5:9b",
          task: "read",
        }).failureCategory,
      ).toBe("tool_execution");
    }
  });

  it("uses outer tool-call evidence for automatic cells that engage Code Mode", () => {
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "",
        effectPassed: true,
        envelope: {
          ...successEnvelope,
          bridgeCalls: { search: 1, describe: 1, call: 0 },
          codeModeEngaged: true,
          toolSummary: { calls: 1, tools: ["exec"] },
        },
        expected: "CM-EXPECTED",
        mode: "auto",
        model: "ollama/qwen3.5:9b",
        task: "read",
      }),
    ).toMatchObject({
      failureCategory: null,
      oracle: { toolExecution: true },
      passed: true,
    });
  });

  it("keeps nested bridge-call evidence mandatory for forced Code Mode", () => {
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "",
        effectPassed: true,
        envelope: {
          ...successEnvelope,
          bridgeCalls: { search: 1, describe: 1, call: 0 },
          toolSummary: { calls: 1, tools: ["exec"] },
        },
        expected: "CM-EXPECTED",
        mode: "code",
        model: "ollama/qwen3.5:9b",
        task: "read",
      }).failureCategory,
    ).toBe("tool_execution");
  });

  it("rejects forced Code Mode runs that never engaged", () => {
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "",
        effectPassed: true,
        envelope: { ...successEnvelope, codeModeEngaged: false },
        expected: "CM-EXPECTED",
        mode: "code",
        model: "ollama/qwen3.5:9b",
        task: "read",
      }).failureCategory,
    ).toBe("activation");
  });

  it("rejects a successful response from a different model route", () => {
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "",
        effectPassed: true,
        envelope: { ...successEnvelope, model: "fallback-model" },
        expected: "CM-EXPECTED",
        mode: "code",
        model: "ollama/qwen3.5:9b",
        task: "read",
      }).failureCategory,
    ).toBe("model_mismatch");
  });

  it("reports an agent error before evaluating missing activation metadata", () => {
    expect(
      classifyCodeModeMatrixCell({
        diagnostics: "",
        effectPassed: false,
        envelope: {
          ...successEnvelope,
          ok: false,
          status: "error",
          final: "",
          codeModeEngaged: undefined,
          error: { kind: "agent_error", message: "run failed" },
        },
        expected: "CM-EXPECTED",
        mode: "code",
        model: "ollama/qwen3.5:9b",
        task: "read",
      }).failureCategory,
    ).toBe("agent_error");
  });
});

describe("Code Mode model matrix artifacts", () => {
  it("writes a zero-cell blocked artifact without leaking the pinned profile id", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-blocked-test-"));
    const previousBaseUrl = process.env.OPENAI_BASE_URL;
    try {
      const configPath = path.join(repoRoot, "matrix.json5");
      const privateProfile = "openai:matrix-private";
      await fs.writeFile(
        configPath,
        frozenConfig.replaceAll("gpt-5.4", "gpt-5.6").replaceAll("openai:matrix", privateProfile),
        "utf8",
      );
      process.env.OPENAI_BASE_URL = "https://proxy.example.invalid/v1";
      const result = await runCodeModeModelMatrix(
        {
          allowFailures: true,
          conversationProof: true,
          config: configPath,
          dryRun: true,
          keepState: false,
          models: ["openai/gpt-5.6"],
          modes: ["direct", "code"],
          outputDir: "artifacts",
          repetitions: 2,
          repoRoot,
          tasks: ["dependent-read-write"],
          thinking: "high",
          timeoutSeconds: 600,
        },
        {
          readAuthProfile: async () => ({
            credentialEnvName: "OPENAI_API_KEY",
            credentialValue: "sk-matrix-test",
            mode: "api_key",
            present: true,
            provider: "openai",
          }),
          readSourceIdentity: async () => ({
            gitSha: "abc123",
            sourceDirty: false,
            sourcePatchSha256: null,
          }),
        },
      );

      expect(result.exitCode).toBe(1);
      expect(result.summary).toMatchObject({
        schemaVersion: 4,
        status: "blocked",
        cellsExecuted: 0,
        blockedReasons: ["provider_route_override_present"],
      });
      const artifacts = await Promise.all(
        ["manifest.json", "results.jsonl", "summary.json", "qa-evidence.json"].map((name) =>
          fs.readFile(path.join(repoRoot, "artifacts", name), "utf8"),
        ),
      );
      expect(artifacts[1]).toBe("");
      expect(artifacts.join("\n")).not.toContain(privateProfile);
      expect(artifacts[3]).toContain("matrix-preflight");
    } finally {
      if (previousBaseUrl === undefined) {
        delete process.env.OPENAI_BASE_URL;
      } else {
        process.env.OPENAI_BASE_URL = previousBaseUrl;
      }
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });

  it("rejects config include graphs instead of claiming a root-file digest is frozen", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-config-test-"));
    try {
      const configPath = path.join(repoRoot, "matrix.json5");
      await fs.writeFile(configPath, '{ "$include": "./provider.json5" }\n', "utf8");
      const result = await runCodeModeModelMatrix(
        {
          allowFailures: false,
          conversationProof: true,
          config: configPath,
          dryRun: true,
          keepState: false,
          models: ["openai/gpt-5.6"],
          modes: ["direct", "code"],
          outputDir: "artifacts",
          repetitions: 2,
          repoRoot,
          tasks: ["dependent-read-write"],
          thinking: "high",
          timeoutSeconds: 600,
        },
        {
          readSourceIdentity: async () => ({
            gitSha: "abc123",
            sourceDirty: false,
            sourcePatchSha256: null,
          }),
        },
      );
      expect(result.exitCode).toBe(1);
      expect(result.summary).toMatchObject({
        schemaVersion: 4,
        status: "blocked",
        cellsExecuted: 0,
        blockedReasons: ["config_include_present"],
      });
      await expect(
        fs.readFile(path.join(repoRoot, "artifacts", "results.jsonl"), "utf8"),
      ).resolves.toBe("");
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });

  it("rejects output inside Git metadata", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-git-test-"));
    try {
      await fs.mkdir(path.join(repoRoot, ".git"));
      await expect(
        runCodeModeModelMatrix(
          {
            allowFailures: false,
            conversationProof: false,
            dryRun: true,
            keepState: false,
            models: ["ollama/qwen3.5:9b"],
            modes: ["code"],
            outputDir: path.join(".git", "refs", "evidence"),
            repetitions: 1,
            repoRoot,
            tasks: ["read"],
            thinking: "off",
            timeoutSeconds: 10,
          },
          {
            readSourceIdentity: async () => ({
              gitSha: "abc123",
              sourceDirty: false,
              sourcePatchSha256: null,
            }),
          },
        ),
      ).rejects.toThrow("must not overlap Git metadata");
      await expect(fs.access(path.join(repoRoot, ".git", "refs"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });

  it("rejects case aliases of missing runtime artifacts", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-case-test-"));
    try {
      const canonicalRoot = await fs.realpath(repoRoot);
      const rootName = path.basename(canonicalRoot);
      const letterIndex = rootName.search(/[a-z]/iu);
      const letter = rootName[letterIndex] ?? "";
      const alternateLetter =
        letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase();
      const alternateRoot = path.join(
        path.dirname(canonicalRoot),
        `${rootName.slice(0, letterIndex)}${alternateLetter}${rootName.slice(letterIndex + 1)}`,
      );
      const caseInsensitive = await fs.realpath(alternateRoot).then(
        (resolved) => resolved === canonicalRoot,
        () => false,
      );
      if (!caseInsensitive) {
        return;
      }

      await expect(
        runCodeModeModelMatrix(
          {
            allowFailures: false,
            conversationProof: false,
            dryRun: true,
            keepState: false,
            models: ["ollama/qwen3.5:9b"],
            modes: ["code"],
            outputDir: path.join("DIST", "evidence"),
            repetitions: 1,
            repoRoot,
            tasks: ["read"],
            thinking: "off",
            timeoutSeconds: 10,
          },
          {
            readSourceIdentity: async () => ({
              gitSha: "abc123",
              sourceDirty: false,
              sourcePatchSha256: null,
            }),
          },
        ),
      ).rejects.toThrow("must not overlap runtime artifacts");
      await expect(fs.access(path.join(repoRoot, "DIST", "evidence"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });

  it("rejects package artifact namespaces before reservation creates them", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-package-test-"));
    try {
      await fs.mkdir(path.join(repoRoot, "packages"));
      await expect(
        runCodeModeModelMatrix(
          {
            allowFailures: false,
            conversationProof: false,
            dryRun: true,
            keepState: false,
            models: ["ollama/qwen3.5:9b"],
            modes: ["code"],
            outputDir: path.join("packages", "new-package", "dist", "evidence"),
            repetitions: 1,
            repoRoot,
            tasks: ["read"],
            thinking: "off",
            timeoutSeconds: 10,
          },
          {
            readSourceIdentity: async () => ({
              gitSha: "abc123",
              sourceDirty: false,
              sourcePatchSha256: null,
            }),
          },
        ),
      ).rejects.toThrow("must not overlap runtime artifacts");
      await expect(fs.access(path.join(repoRoot, "packages", "new-package"))).rejects.toMatchObject(
        {
          code: "ENOENT",
        },
      );
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });

  it.each(["dist", path.join("packages", "agent-core", "dist")])(
    "rejects output inside build-created runtime artifacts: %s",
    async (artifactDir) => {
      const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-build-test-"));
      let hashed = false;
      try {
        await expect(
          runCodeModeModelMatrix(
            {
              allowFailures: false,
              conversationProof: false,
              dryRun: false,
              keepState: false,
              models: ["ollama/qwen3.5:9b"],
              modes: ["code"],
              outputDir: path.join(artifactDir, "evidence"),
              repetitions: 1,
              repoRoot,
              tasks: ["read"],
              thinking: "off",
              timeoutSeconds: 10,
            },
            {
              buildCliArtifacts: async () => {
                await fs.mkdir(path.join(repoRoot, artifactDir), { recursive: true });
              },
              readBuildSha256: async () => {
                hashed = true;
                return "build123";
              },
              readSourceIdentity: async () => ({
                gitSha: "abc123",
                sourceDirty: false,
                sourcePatchSha256: null,
              }),
            },
          ),
        ).rejects.toThrow("must not overlap runtime artifacts");
        expect(hashed).toBe(false);
        await expect(fs.access(path.join(repoRoot, artifactDir, "evidence"))).rejects.toMatchObject(
          {
            code: "ENOENT",
          },
        );
      } finally {
        await fs.rm(repoRoot, { force: true, recursive: true });
      }
    },
  );

  it("stops after the first harness failure because no auditable trace exists", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-matrix-test-"));
    try {
      const configPath = path.join(repoRoot, "matrix.json5");
      await fs.writeFile(configPath, frozenConfig.replaceAll("gpt-5.4", "gpt-5.6"), "utf8");
      let calls = 0;
      let buildReads = 0;
      const result = await runCodeModeModelMatrix(
        {
          allowFailures: false,
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
          now: () => new Date("2026-07-28T12:00:00Z"),
          readBuildSha256: async () => {
            buildReads += 1;
            if (buildReads === 1) {
              const entries = await fs.readdir(path.join(repoRoot, "artifacts"));
              expect(entries).toEqual(["results.jsonl"]);
            }
            return "build123";
          },
          readSourceIdentity: async () => ({
            gitSha: "abc123",
            sourceDirty: false,
            sourcePatchSha256: null,
          }),
          readAuthProfile: matrixAuthProfile,
          runCell: async ({ buildSha256, cell, configSha256, gitSha }) => {
            calls += 1;
            void buildSha256;
            void cell;
            void configSha256;
            void gitSha;
            throw new Error("fixture exploded");
          },
        },
      );

      expect(calls).toBe(1);
      expect(result.exitCode).toBe(1);
      const summary = JSON.parse(
        await fs.readFile(path.join(repoRoot, "artifacts", "summary.json"), "utf8"),
      ) as {
        counts: { total: number; passed: number; failed: number };
      };
      expect(summary.counts).toEqual({ total: 1, passed: 0, failed: 1 });
      const lines = (await fs.readFile(path.join(repoRoot, "artifacts", "results.jsonl"), "utf8"))
        .trim()
        .split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
        failureCategory: "proof_drift",
        error: { kind: "frontier_receipt_missing_or_invalid" },
      });
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });

  it("stops before the next cell when the frozen source changes", async () => {
    const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-code-mode-stop-test-"));
    try {
      const configPath = path.join(repoRoot, "matrix.json5");
      await fs.writeFile(configPath, frozenConfig, "utf8");
      let calls = 0;
      let sourceReads = 0;
      const result = await runCodeModeModelMatrix(
        {
          allowFailures: false,
          conversationProof: false,
          config: configPath,
          dryRun: false,
          keepState: false,
          models: ["openai/gpt-5.4"],
          modes: ["direct", "code"],
          outputDir: "artifacts",
          repetitions: 2,
          repoRoot,
          tasks: ["read"],
          thinking: "high",
          timeoutSeconds: 600,
        },
        {
          buildCliArtifacts: async () => {},
          readBuildSha256: async () => "build123",
          readSourceIdentity: async () => {
            sourceReads += 1;
            return sourceReads >= 3
              ? {
                  gitSha: "abc123",
                  sourceDirty: true,
                  sourcePatchSha256: "changed",
                }
              : {
                  gitSha: "abc123",
                  sourceDirty: false,
                  sourcePatchSha256: null,
                };
          },
          readAuthProfile: matrixAuthProfile,
          runCell: async ({ buildSha256, cell, configSha256, gitSha }) => {
            calls += 1;
            const fixture = await prepareCodeModeMatrixTaskFixture(
              path.join(repoRoot, `fixture-${calls}`),
              cell,
            );
            return {
              buildSha256,
              firstLogicalCallCacheStatus: "unknown",
              codeModeEngaged: cell.mode === "code",
              configSha256,
              elapsedMs: 10,
              expected: fixture.expected,
              failureCategory: null,
              final: fixture.expected,
              fixtureSha256: fixture.fixtureSha256,
              gitSha,
              id: cell.id,
              mode: cell.mode,
              model: cell.model,
              observedModel: "gpt-5.4",
              observedProvider: "openai",
              oracle: {
                answer: true,
                effect: true,
                engagement: true,
                identity: true,
                toolExecution: true,
              },
              passed: true,
              promptSha256: fixture.promptSha256,
              repetition: cell.repetition,
              sourceDirty: false,
              sourcePatchSha256: null,
              status: "ok",
              task: cell.task,
              timestamp: "2026-08-06T00:00:00.000Z",
            } satisfies CodeModeMatrixCellResult;
          },
        },
      );

      expect(calls).toBe(1);
      expect(result.exitCode).toBe(1);
      expect(result.summary).toMatchObject({
        counts: { total: 1, failed: 1 },
      });
      const firstResult = JSON.parse(
        (await fs.readFile(path.join(repoRoot, "artifacts", "results.jsonl"), "utf8")).trim(),
      ) as CodeModeMatrixCellResult;
      expect(firstResult).toMatchObject({
        error: { kind: "source_mismatch", message: "source_mismatch" },
        failureCategory: "proof_drift",
      });
    } finally {
      await fs.rm(repoRoot, { force: true, recursive: true });
    }
  });
});

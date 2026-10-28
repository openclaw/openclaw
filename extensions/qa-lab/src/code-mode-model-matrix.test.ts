// Code Mode model matrix tests cover repeatable small-model acceptance evidence.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker, withTempDir } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildCodeModeMatrixAgentEnv,
  classifyCodeModeMatrixCell,
  modelCellPrefix,
  parseCodeModeMatrixOptions,
  runCodeModeModelMatrix,
  type CodeModeMatrixCellResult,
  type CodeModeMatrixTask,
} from "../../../scripts/code-mode-model-matrix.ts";
import { readMatrixModelAccounting } from "../../../scripts/lib/code-mode-matrix-usage.js";
import {
  getEffectiveQaEvidenceEntries,
  projectQaEvidenceScenarioOutcomes,
  validateQaEvidenceSummaryJson,
} from "../api.js";
import {
  matrixArtifactOptions,
  matrixDependencies,
  matrixResult,
  matrixSourceIdentity,
} from "./code-mode-model-matrix.test-support.js";

const extendedTasks = [
  "large-result-reduction",
  "parallel-independent-reads",
  "dependent-chain",
] as const satisfies readonly CodeModeMatrixTask[];
const fixtureArgs = ["--model", "fixture/model", "--mode", "code", "--repetitions", "1"];

// A synthetic CLI, not a model or Code Mode runtime: exercise the real runner's
// fixture preparation, process envelope, effect oracle, and artifact projection.
// It consumes only task files/arguments; no provider imports or credentials.
const fixtureCli = String.raw`
import fs from "node:fs/promises";
import path from "node:path";
const option = (name) => process.argv[process.argv.indexOf(name) + 1];
const workspace = option("--cwd");
if (process.argv.includes("--local-model-lean")) throw new Error("unexpected lean profile");
const config = JSON.parse(await fs.readFile(option("--config"), "utf8"));
if (config.agents.defaults.models[option("--model")].agentRuntime.id !== "openclaw"
  || config.agents.defaults.fastModeDefault !== false
  || config.tools.codeMode.executor !== "node"
  || config.tools.toolSearch !== undefined) throw new Error("benchmark controls drifted");
const prompt = process.argv[4];
let calls = 0;
const read = async (name) => {
  calls++;
  return await fs.readFile(path.join(workspace, name), "utf8");
};
const readJson = async (name) => JSON.parse(await read(name));
let answer;
if (prompt.includes("orders.jsonl")) {
  const rules = await readJson("rules.json");
  const orders = await read("orders.jsonl");
  if (Buffer.byteLength(orders) <= 65536 || Buffer.byteLength(orders) > 131072) {
    throw new Error("reduction fixture must require bounded large-result handling");
  }
  let count = 0;
  let sum = 0;
  for (const line of orders.trim().split("\n")) {
    const order = JSON.parse(line);
    if (order.region !== rules.region || order.units < rules.minUnits) continue;
    count++;
    sum += order.units * order.unitPriceCents;
  }
  answer = [rules.verificationCode, count, sum].join(":");
} else if (prompt.includes("north.json")) {
  const values = await Promise.all(["north.json", "south.json", "west.json"].map(readJson));
  answer = values.map((entry) => entry.value).join("|");
} else if (prompt.includes("start.json")) {
  const start = await readJson("start.json");
  const route = await readJson(start.next);
  answer = (await readJson(route.next)).value;
} else {
  throw new Error("unsupported fixture prompt");
}
if (option("--thinking") !== "missing-effect") {
  await fs.writeFile(path.join(workspace, "result.txt"), answer);
  calls++;
  if (await read("result.txt") !== answer) throw new Error("readback mismatch");
}
const engaged = option("--code-mode") === "code";
const [provider, model] = option("--model").split("/");
console.log(JSON.stringify({
  ok: true, status: "ok", final: option("--thinking") === "wrong-answer" ? "wrong" : answer,
  payloads: [], model, provider, sessionId: "fixture-only", codeModeEngaged: engaged,
  assistantTurns: 2,
  ...(engaged ? { bridgeCalls: { search: 0, describe: 0, call: calls } } : {}),
  toolSummary: { calls: engaged ? 1 : calls, tools: engaged ? ["exec"] : ["read", "write"] }
}));
`;

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const readArtifact = (dir: string, name: string) => fs.readFile(path.join(dir, name), "utf8");
const missing = (file: string) => expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });
const metric = (value?: number) =>
  value === undefined
    ? { samples: 0, total: null, p50: null }
    : { samples: 1, total: value, p50: value };

async function readEvidence(dir: string) {
  const evidence = validateQaEvidenceSummaryJson(
    JSON.parse(await readArtifact(dir, "qa-evidence.json")),
  );
  expect(evidence.schemaVersion).toBe(3);
  if (evidence.schemaVersion !== 3) {
    throw new Error("expected invocation-owned evidence");
  }
  return evidence;
}

describe("Code Mode model matrix provider setup", () => {
  const envFor = (model: string, env: NodeJS.ProcessEnv = {}) =>
    buildCodeModeMatrixAgentEnv(model, "/runtime", env);

  it("adds the documented non-secret marker only for local Ollama runs", () => {
    expect(envFor("ollama/qwen3.5:9b")).toMatchObject({
      NODE_DISABLE_COMPILE_CACHE: "1",
      OLLAMA_API_KEY: "ollama-local",
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join("/runtime", "dist", "extensions"),
    });
    expect(envFor("ollama/qwen3.5:9b", { OLLAMA_API_KEY: "configured-value" }).OLLAMA_API_KEY).toBe(
      "configured-value",
    );
    expect(envFor("huggingface/model").OLLAMA_API_KEY).toBe(undefined);
    const isolated = envFor("ollama/fixture", {
      HOME: "/operator",
      CODEX_HOME: "/operator/codex",
      OPENCLAW_CONFIG_PATH: "/operator/config",
      UNRELATED_TOKEN: "synthetic-unrelated-value",
      PATH: "/bin",
    });
    expect(isolated.PATH).toBe("/bin");
    expect(isolated).not.toHaveProperty("HOME");
    expect(isolated).not.toHaveProperty("CODEX_HOME");
    expect(isolated).not.toHaveProperty("OPENCLAW_CONFIG_PATH");
    expect(isolated).not.toHaveProperty("UNRELATED_TOKEN");
  });

  it("rejects competing credentials and non-API-key provider routes", () => {
    expect(() =>
      envFor("openai/fixture", {
        OPENAI_API_KEY: "synthetic-primary",
        CODEX_API_KEY: "synthetic-competitor",
      }),
    ).toThrow("Ambiguous benchmark authentication");
    expect(() =>
      envFor("anthropic/fixture", {
        ANTHROPIC_OAUTH_TOKEN: "synthetic-oauth",
      }),
    ).toThrow("requires an API-key environment input");
    const env = envFor("anthropic/fixture", {
      ANTHROPIC_API_KEY: "synthetic-selected",
      OPENAI_API_KEY: "synthetic-unrelated",
    });
    expect(env.ANTHROPIC_API_KEY).toBe("synthetic-selected");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
  });
});

describe("Code Mode model matrix identity", () => {
  it("keeps punctuation variants distinct", () => {
    expect(modelCellPrefix("ollama/foo.bar")).not.toBe(modelCellPrefix("ollama/foo-bar"));
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

  type Classification = Parameters<typeof classifyCodeModeMatrixCell>[0];
  function classify({
    envelope,
    ...overrides
  }: Partial<Omit<Classification, "envelope">> & {
    envelope?: Partial<Classification["envelope"]>;
  }) {
    return classifyCodeModeMatrixCell({
      diagnostics: "",
      effectPassed: true,
      envelope: { ...successEnvelope, ...envelope },
      expected: "CM-EXPECTED",
      mode: "code",
      model: "ollama/qwen3.5:9b",
      ...overrides,
    });
  }

  it.each([
    ["HTTP 402 payment required", "credits depleted", "provider_billing"],
    ["HTTP 403", "You do not have access to this model", "model_unavailable"],
    ["HTTP 403", "Invalid API key", "provider_auth"],
    ["HTTP 403", "Forbidden", "provider_auth"],
  ])("classifies %s with %s as %s", (diagnostics, message, category) => {
    expect(
      classify({
        diagnostics,
        effectPassed: false,
        envelope: {
          ok: false,
          status: "error",
          final: "",
          error: { kind: "error_payload", message },
        },
      }).failureCategory,
    ).toBe(category);
  });

  it.each([
    [
      "recovered provider diagnostic",
      { diagnostics: "recovered after a transient network socket error" },
      null,
    ],
    [
      "trailing stdout",
      { diagnostics: "unexpected stdout after JSON: noisy log", stdoutContractValid: false },
      "harness_error",
    ],
    [
      "missing nested bridge call",
      {
        envelope: {
          bridgeCalls: { search: 1, describe: 1, call: 0 },
          toolSummary: { calls: 1, tools: ["exec"] },
        },
      },
      "tool_execution",
    ],
    ["missing forced engagement", { envelope: { codeModeEngaged: false } }, "activation"],
    ["different model route", { envelope: { model: "fallback-model" } }, "model_mismatch"],
    [
      "agent error before activation",
      {
        effectPassed: false,
        envelope: {
          ok: false,
          status: "error",
          final: "",
          codeModeEngaged: undefined,
          error: { kind: "agent_error", message: "run failed" },
        },
      },
      "agent_error",
    ],
  ] satisfies Array<[string, Parameters<typeof classify>[0], string | null]>)(
    "classifies %s",
    (_name, input, category) => {
      expect(classify(input).failureCategory).toBe(category);
    },
  );

  it("classifies a direct read with extra prose as an answer mismatch", () => {
    expect(
      classify({
        envelope: {
          bridgeCalls: { search: 0, describe: 0, call: 0 },
          codeModeEngaged: false,
          final: "The value is CM-EXPECTED.",
        },
        mode: "direct",
      }),
    ).toMatchObject({
      failureCategory: "answer_mismatch",
      oracle: { answer: false, toolExecution: true },
    });
  });

  it("requires outer tool-call evidence for direct and automatic cells", () => {
    for (const mode of ["direct", "auto"] as const) {
      expect(
        classify({
          envelope: {
            codeModeEngaged: mode === "auto",
            toolSummary: { calls: 0, tools: [] },
          },
          mode,
        }).failureCategory,
      ).toBe("tool_execution");
    }
  });

  it("uses outer tool-call evidence for automatic cells that engage Code Mode", () => {
    expect(
      classify({
        envelope: {
          bridgeCalls: { search: 1, describe: 1, call: 0 },
          codeModeEngaged: true,
          toolSummary: { calls: 1, tools: ["exec"] },
        },
        mode: "auto",
      }),
    ).toMatchObject({
      failureCategory: null,
      oracle: { toolExecution: true },
      passed: true,
    });
  });
});

describe("Code Mode model matrix extended fixtures", () => {
  it.each([
    ["off", null],
    ["wrong-answer", "answer_mismatch"],
    ["missing-effect", "effect_mismatch"],
  ] as const)(
    "runs task fixtures through the process/evidence boundary: %s",
    async (thinking, failureCategory) => {
      const repoRoot = tempDirs.make("openclaw-matrix-fixtures-");
      await fs.mkdir(path.join(repoRoot, "dist"));
      await fs.mkdir(path.join(repoRoot, "node_modules"));
      await fs.writeFile(path.join(repoRoot, "package.json"), JSON.stringify({ type: "module" }));
      await fs.writeFile(path.join(repoRoot, "dist", "entry.js"), fixtureCli);
      const options = parseCodeModeMatrixOptions(
        [
          ...fixtureArgs,
          "--concurrency",
          "1",
          "--keep-state",
          ...(failureCategory ? [] : ["--mode", "direct"]),
          ...extendedTasks.flatMap((task) => ["--task", task]),
          "--thinking",
          thinking,
          "--output-dir",
          "artifacts",
        ],
        repoRoot,
      );
      const result = await runCodeModeModelMatrix(
        options,
        matrixDependencies({
          readBuildSha256: async () => "fixture-build",
          readSourceIdentity: matrixSourceIdentity("fixture-source"),
        }),
      );
      const read = (name: string) => readArtifact(result.outputDir, name);
      const rows = (await read("results.jsonl"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as CodeModeMatrixCellResult);
      expect(result.exitCode).toBe(failureCategory ? 1 : 0);
      expect(rows).toHaveLength(failureCategory ? 3 : 6);
      const manifest = JSON.parse(await read("manifest.json"));
      expect(manifest).toMatchObject({
        tasks: extendedTasks,
        cells: rows.map((row) => row.id),
      });
      expect(manifest).not.toHaveProperty("gatewayExecutor");
      for (const row of rows) {
        expect(row).not.toHaveProperty("executor");
        expect(row).toMatchObject({
          failureCategory,
          passed: failureCategory === null,
          assistantTurns: 2,
          oracle: {
            answer: thinking !== "wrong-answer",
            effect: thinking !== "missing-effect",
            engagement: true,
            identity: true,
            toolExecution: true,
          },
        });
        expect(row.elapsedMs).toBeGreaterThanOrEqual(0);
        const workspace = path.join(result.outputDir, "state", row.id, "workspace");
        if (thinking === "missing-effect") {
          await missing(path.join(workspace, "result.txt"));
        } else {
          expect(await fs.readFile(path.join(workspace, "result.txt"), "utf8")).toBe(row.expected);
        }
        if (row.mode === "direct") {
          const codeRow = rows.find(
            (candidate) => candidate.task === row.task && candidate.mode === "code",
          )!;
          expect(row.expected).toBe(codeRow.expected);
          expect(row.bridgeCalls).toBeUndefined();
          const codeWorkspace = path.join(result.outputDir, "state", codeRow.id, "workspace");
          for (const name of await fs.readdir(workspace)) {
            expect(await fs.readFile(path.join(workspace, name), "utf8")).toBe(
              await fs.readFile(path.join(codeWorkspace, name), "utf8"),
            );
          }
        }
      }
      const evidence = await readEvidence(result.outputDir);
      expect(evidence.entries).toHaveLength(rows.length);
      const outcomes = projectQaEvidenceScenarioOutcomes(evidence);
      expect(outcomes.map((outcome) => outcome.scenarioId)).toEqual(rows.map((row) => row.id));
      expect(outcomes.map((outcome) => outcome.status)).toEqual(
        rows.map(() => (failureCategory ? "fail" : "pass")),
      );
      expect(getEffectiveQaEvidenceEntries(evidence)).toEqual(evidence.entries);
      for (const occurrence of evidence.occurrences) {
        expect(occurrence.retryOf).toBeNull();
        expect(occurrence.launch).toMatchObject({
          source: { ref: "fixture-source", integrity: "git:fixture-source" },
          runtime: process.versions.bun
            ? { id: "bun", version: process.versions.bun }
            : { id: "node", version: process.version },
          package: null,
          protocol: null,
          accountRef: null,
          proofClass: null,
        });
        for (const receipt of occurrence.receipts) {
          expect(receipt.phase).toBe("prepared");
          const bytes = await fs.readFile(path.join(result.outputDir, receipt.artifact.path));
          expect(createHash("sha256").update(bytes).digest("hex")).toBe(receipt.artifact.sha256);
          expect(JSON.parse(bytes.toString()).result.evidenceOccurrenceId).toBe(occurrence.id);
        }
      }
      evidence.entries.forEach((entry, index) => {
        expect(entry.binding).toEqual({
          occurrenceId: rows[index]!.evidenceOccurrenceId,
          assertionId: null,
          receiptId: null,
        });
        expect(entry.result).toMatchObject({
          status: failureCategory ? "fail" : "pass",
          timing: { wallMs: Math.max(1, rows[index]!.elapsedMs) },
        });
        if (failureCategory) {
          expect(entry.result.failure?.class).toBe(failureCategory);
        }
      });
    },
  );

  it("plans extended tasks without building, executing, or fabricating passing evidence", async () => {
    const repoRoot = tempDirs.make("openclaw-matrix-plan-");
    const options = parseCodeModeMatrixOptions(
      [...fixtureArgs, "--dry-run", ...extendedTasks.flatMap((task) => ["--task", task])],
      repoRoot,
    );
    const forbidden = async (): Promise<never> => {
      throw new Error("dry run must not execute");
    };
    const result = await runCodeModeModelMatrix(options, {
      readSourceIdentity: matrixSourceIdentity("fixture-source"),
      buildCliArtifacts: forbidden,
      readBuildSha256: forbidden,
      runCell: forbidden,
    });
    expect(result.summary).toEqual({ status: "dry-run", total: 3 });
    const manifest = JSON.parse(await readArtifact(result.outputDir, "manifest.json"));
    expect(manifest).toMatchObject({ tasks: extendedTasks, buildSha256: null });
    expect(manifest.cells).toHaveLength(3);
    const evidence = await readEvidence(result.outputDir);
    expect(evidence.entries).toEqual([]);
    expect(evidence.occurrences).toHaveLength(3);
    expect(evidence.occurrences.map((occurrence) => occurrence.scenario)).toEqual(
      manifest.cells.map(() => ({ kind: "instance", resultOccurrenceId: null })),
    );
    expect(projectQaEvidenceScenarioOutcomes(evidence).map((outcome) => outcome.status)).toEqual([
      null,
      null,
      null,
    ]);
    await missing(path.join(result.outputDir, "results.jsonl"));
  });
});

describe("Code Mode model matrix artifacts", () => {
  async function rejectOutput(repoRoot: string, output: string, category: string) {
    await expect(
      runCodeModeModelMatrix(matrixArtifactOptions(repoRoot, output, { dryRun: true }), {
        readSourceIdentity: matrixSourceIdentity("abc123"),
      }),
    ).rejects.toThrow(`must not overlap ${category}`);
  }

  it("rejects output inside Git metadata", async () => {
    await withTempDir("openclaw-code-mode-git-test-", async (repoRoot) => {
      await fs.mkdir(path.join(repoRoot, ".git"));
      await rejectOutput(repoRoot, path.join(".git", "refs", "evidence"), "Git metadata");
      await missing(path.join(repoRoot, ".git", "refs"));
    });
  });

  it("rejects case aliases of missing runtime artifacts", async () => {
    await withTempDir("openclaw-code-mode-case-test-", async (repoRoot) => {
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

      await rejectOutput(repoRoot, path.join("DIST", "evidence"), "runtime artifacts");
      await missing(path.join(repoRoot, "DIST", "evidence"));
    });
  });

  it("rejects package artifact namespaces before reservation creates them", async () => {
    await withTempDir("openclaw-code-mode-package-test-", async (repoRoot) => {
      await fs.mkdir(path.join(repoRoot, "packages"));
      await rejectOutput(
        repoRoot,
        path.join("packages", "new-package", "dist", "evidence"),
        "runtime artifacts",
      );
      await missing(path.join(repoRoot, "packages", "new-package"));
    });
  });

  it.each(["dist", path.join("packages", "agent-core", "dist")])(
    "rejects output inside build-created runtime artifacts: %s",
    async (artifactDir) => {
      await withTempDir("openclaw-code-mode-build-test-", async (repoRoot) => {
        let hashed = false;
        await expect(
          runCodeModeModelMatrix(
            matrixArtifactOptions(repoRoot, path.join(artifactDir, "evidence")),
            {
              buildCliArtifacts: async () => {
                await fs.mkdir(path.join(repoRoot, artifactDir), { recursive: true });
              },
              readBuildSha256: async () => {
                hashed = true;
                return "build123";
              },
              readSourceIdentity: matrixSourceIdentity("abc123"),
            },
          ),
        ).rejects.toThrow("must not overlap runtime artifacts");
        expect(hashed).toBe(false);
        await missing(path.join(repoRoot, artifactDir, "evidence"));
      });
    },
  );

  it.each([
    ["aggregate only", 9, undefined],
    ["outer only, including zero", undefined, 0],
    ["both scopes", 9, 4],
    ["unavailable", undefined, undefined],
  ] as const)("keeps tool summary scopes separate: %s", async (_name, calls, outerCalls) => {
    const repoRoot = tempDirs.make("openclaw-code-mode-metrics-");
    const result = await runCodeModeModelMatrix(
      matrixArtifactOptions(repoRoot, "artifacts", { models: ["ollama/fixture"] }),
      matrixDependencies({
        readBuildSha256: async () => "build123",
        readSourceIdentity: matrixSourceIdentity("abc123"),
        runCell: async (params) =>
          matrixResult(params.cell, {
            buildSha256: params.buildSha256,
            gitSha: params.gitSha,
            // This envelope models mixed outer/nested terminals, not nine outer calls.
            ...(calls !== undefined
              ? {
                  toolSummary: { calls, tools: ["exec", "read", "write"] },
                  bridgeCalls: { search: 0, describe: 0, call: 5 },
                }
              : {}),
            ...(outerCalls !== undefined
              ? {
                  gateway: {
                    modelAccounting: await readMatrixModelAccounting({
                      file: path.join(repoRoot, "absent-model-timeline.jsonl"),
                      joined: false,
                      foregroundRunIds: [],
                    }),
                    outerCalls,
                    promptSha256: "prompt123",
                    fixtureSha256: "fixture123",
                    settings: {
                      executor: "node",
                      thinking: "off",
                      timeoutSeconds: 10,
                      execTimeoutMs: 10,
                      maxOutputBytes: 1024,
                      maxModelOutputTokens: 128,
                      runtime: "openclaw",
                      fast: false,
                      allowedTools: ["read"],
                    },
                    behavior: {},
                    startupMs: 0,
                    traceAvailable: true,
                    interview: {
                      traceAvailable: false,
                      answer: null,
                      rationaleReview: "required",
                      checks: {},
                    },
                    artifacts: {
                      taskTrace: "task.json",
                      interviewTrace: "interview.json",
                      receipts: "receipts.json",
                      taskReceipts: "task-receipts.json",
                      interviewReceipts: "interview-receipts.json",
                      log: "gateway.log",
                    },
                  },
                }
              : {}),
          }),
      }),
    );
    expect(result.exitCode).toBe(0);
    const summary = JSON.parse(await readArtifact(result.outputDir, "summary.json"));
    expect(summary.groups).toMatchObject([
      {
        metrics: {
          toolCalls: metric(calls),
          outerToolCalls: metric(outerCalls),
          bridgeToolCalls: metric(calls === undefined ? undefined : 5),
        },
      },
    ]);
  });

  it("continues after cell crashes and reports first-pass versus eventual success", async () => {
    await withTempDir("openclaw-code-mode-matrix-test-", async (repoRoot) => {
      let calls = 0;
      let initialBuildRead = true;
      const result = await runCodeModeModelMatrix(
        matrixArtifactOptions(repoRoot, "artifacts", { repetitions: 2 }),
        matrixDependencies({
          now: () => new Date("2026-07-28T12:00:00Z"),
          readBuildSha256: async () => {
            if (initialBuildRead) {
              expect(await fs.readdir(path.join(repoRoot, "artifacts"))).toEqual([]);
              initialBuildRead = false;
            }
            return "build123";
          },
          readSourceIdentity: matrixSourceIdentity("abc123"),
          runCell: async ({ cell, gitSha }) => {
            calls += 1;
            const before = await readEvidence(path.join(repoRoot, "artifacts"));
            expect(
              projectQaEvidenceScenarioOutcomes(before).map((outcome) => outcome.status),
            ).toEqual(calls === 1 ? [null, null] : ["fail", null]);
            if (cell.repetition === 1) {
              throw new Error("fixture exploded");
            }
            return matrixResult(cell, {
              buildSha256: "build123",
              bridgeCalls: { search: 0, describe: 0, call: 1 },
              elapsedMs: 10,
              gitSha,
              toolSummary: { calls: 1, tools: ["exec"] },
            });
          },
        }),
      );

      expect(calls).toBe(2);
      expect(result.exitCode).toBe(1);
      const summary = JSON.parse(await readArtifact(result.outputDir, "summary.json")) as {
        counts: { total: number; passed: number; failed: number };
        groupCounts: { total: number; firstPassPassed: number; eventualPassed: number };
        groups: Array<{ firstPassPassed: boolean; eventualPassed: boolean }>;
      };
      expect(summary.counts).toEqual({ total: 2, passed: 1, failed: 1 });
      expect(summary.groupCounts).toEqual({ total: 1, firstPassPassed: 0, eventualPassed: 1 });
      expect(summary.groups).toMatchObject([
        {
          firstPassPassed: false,
          eventualPassed: true,
          metrics: {
            assistantTurns: metric(),
            costUsd: metric(),
            toolCalls: metric(1),
            outerToolCalls: metric(),
            bridgeToolCalls: metric(1),
            bridgeSearchCalls: metric(0),
            bridgeDescribeCalls: metric(0),
          },
        },
      ]);
      const lines = (await readArtifact(result.outputDir, "results.jsonl")).trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
        failureCategory: "harness_error",
        error: { kind: "harness_error", message: "fixture exploded" },
      });
      const evidence = await readEvidence(result.outputDir);
      expect(evidence.occurrences).toHaveLength(4);
      expect(new Set(evidence.occurrences.map((occurrence) => occurrence.id)).size).toBe(4);
      expect(evidence.occurrences.every((occurrence) => occurrence.retryOf === null)).toBe(true);
      expect(projectQaEvidenceScenarioOutcomes(evidence).map((outcome) => outcome.status)).toEqual([
        "fail",
        "pass",
      ]);
      expect(getEffectiveQaEvidenceEntries(evidence)).toHaveLength(2);
      expect(evidence.entries).toHaveLength(2);
      expect(evidence.entries[0]).toMatchObject({
        test: {
          kind: "script-test",
          source: { path: "scripts/code-mode-model-matrix.ts" },
        },
        execution: {
          provider: {
            id: "ollama",
            model: { name: "qwen3.5:9b", ref: "ollama/qwen3.5:9b" },
          },
          artifacts: [
            { kind: "manifest", path: "manifest.json" },
            { kind: "summary", path: "summary.json" },
            { kind: "results", path: "results.jsonl" },
            {
              kind: "matrix-observation",
              path: `observations/${evidence.entries[0]!.binding.occurrenceId}.json`,
              source: "code-mode-model-matrix",
            },
          ],
        },
        result: {
          status: "fail",
          failure: { class: "harness_error", reason: "harness_error" },
        },
      });
      expect(evidence.entries[1]).toMatchObject({
        result: { status: "pass", timing: { wallMs: 10 } },
      });
    });
  });
});

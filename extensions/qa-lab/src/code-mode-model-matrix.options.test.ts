import { describe, expect, it } from "vitest";
import {
  parseCodeModeMatrixOptions,
  resolveCodeModeMatrixOutputDir,
} from "../../../scripts/code-mode-model-matrix.ts";

const parse = (args: string, cwd?: string) =>
  parseCodeModeMatrixOptions(args ? args.split(" ") : [], cwd);
const rejects = (args: string, error?: string) => expect(() => parse(args)).toThrow(error);
const model = "--model openai/fixture";
const gateway = `${model} --mode code --task javascript-contracts`;

describe("Code Mode model matrix options", () => {
  it("defaults to the complete bounded matrix", () => {
    expect(parseCodeModeMatrixOptions(["--model", "ollama/qwen3.5:9b"], "/repo")).toMatchObject({
      models: ["ollama/qwen3.5:9b"],
      gatewayExecutor: "node",
      modes: ["direct", "auto", "code"],
      tasks: ["read", "dependent-read-write"],
      repetitions: 3,
      timeoutSeconds: 180,
      thinking: "low",
      concurrency: 2,
      maxCells: 36,
      repoRoot: "/repo",
    });
  });

  it("keeps Gateway interviews opt-in and resolves comparison inputs independently of output storage", () => {
    const selection = "--model openai/gpt-5.6-luna --task inventory-join";
    const args = `${selection} --mode code --executor quickjs --runtime-dir ../baseline --baseline-results artifacts/previous/results.jsonl --repetitions 1`;
    expect(parse(args, "/harness")).toMatchObject({
      repoRoot: "/harness",
      gatewayExecutor: "quickjs",
      runtimeDir: "/baseline",
      baselineResults: "/harness/artifacts/previous/results.jsonl",
      tasks: ["inventory-join"],
      modes: ["code"],
      repetitions: 1,
    });
  });

  it.each<[string, string | undefined]>([
    ["", "At least one --model"],
    ["--model qwen3.5:9b", "provider/model"],
    [`${model} --task unknown`, "--task must be one of"],
    [`${model} --task dependent-chain --task dependent-chain`, "Duplicate --task"],
    [`${model} --task inventory-join`, "--mode code"],
    ["--model fixture/model --mode code --task partial-failure", "OpenAI, Anthropic, or Google"],
    [`${gateway} --executor unknown`, "--executor must be node or quickjs"],
    [`${gateway} --executor node --executor quickjs`, "provided more than once"],
    [`${gateway} --executor quickjs --task read`, "only Gateway-backed tasks"],
    [`${model} --executor node`, "only Gateway-backed tasks"],
    [`${model} --mode code --mode code`, "Duplicate --mode"],
    ...["--concurrency 4", "--max-tokens 0", "--max-known-cost-usd NaN"].map(
      (arg): [string, undefined] => [`${model} ${arg}`, undefined],
    ),
    ...["auto", "direct", "code"].map((mode): [string, string] => [
      `${model} --task invoice-reconciliation --mode ${mode}`,
      "both explicit direct/code",
    ]),
    ...["--skip-build", "constructor", "toString", "__proto__"].map((arg): [string, string] => [
      `${model} ${arg} 1`,
      `Unknown argument: ${arg}`,
    ]),
  ])("rejects invalid options: %s", (args, error) => rejects(args, error));

  it("admits neutral direct/code pairs for all supported providers with bounded root concurrency", () => {
    const args =
      "--model anthropic/fixture --model google/fixture --task invoice-reconciliation --concurrency 3 --max-known-cost-usd 0.5 --schedule waves.json";
    expect(parse(args, "/harness")).toMatchObject({
      modes: ["direct", "code"],
      concurrency: 3,
      maxKnownCostUsd: 0.5,
      schedulePath: "/harness/waves.json",
    });
  });

  it("rejects output paths outside the repository", () => {
    for (const [output, error] of [
      ["../outside", "within the repository"],
      ["/tmp/out", "repo-relative"],
      [".", "within the repository"],
    ]) {
      expect(() =>
        resolveCodeModeMatrixOutputDir("/repo", output, new Date("2026-07-28T12:00:00Z")),
      ).toThrow(error);
    }
  });
});

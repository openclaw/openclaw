import { describe, expect, it } from "vitest";
import {
  parseCodeModeMatrixOptions,
  resolveCodeModeMatrixOutputDir,
} from "../../../scripts/code-mode-model-matrix.ts";

const parse = (args: string, cwd?: string) =>
  parseCodeModeMatrixOptions(args ? args.split(" ") : [], cwd);

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

  it("rejects invalid and duplicate extended task selectors", () => {
    for (const [tasks, error] of [
      ["unknown", "--task must be one of"],
      ["dependent-chain --task dependent-chain", "Duplicate --task"],
    ]) {
      expect(() => parse(`--model fixture/model --task ${tasks}`)).toThrow(error);
    }
  });

  it("keeps Gateway interviews opt-in and resolves comparison inputs independently of output storage", () => {
    const selection = "--model openai/gpt-5.6-luna --task inventory-join";
    expect(() => parse(selection, "/harness")).toThrow("--mode code");
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
    expect(() => parse("--model fixture/model --mode code --task partial-failure")).toThrow(
      "OpenAI, Anthropic, or Google",
    );
  });

  it.each([
    ["--executor unknown", "--executor must be node or quickjs"],
    ["--executor node --executor quickjs", "provided more than once"],
    ["--executor quickjs --task read", "only Gateway-backed tasks"],
  ])("rejects invalid or ambiguous executor selection: %s", (args, error) => {
    expect(() =>
      parse(`--model openai/fixture --mode code --task javascript-contracts ${args}`),
    ).toThrow(error);
  });

  it("rejects a Gateway executor selector for embedded tasks", () => {
    expect(() =>
      parseCodeModeMatrixOptions(["--model", "openai/fixture", "--executor", "node"]),
    ).toThrow("only Gateway-backed tasks");
  });

  it("admits neutral direct/code pairs for all supported providers with bounded root concurrency", () => {
    const args =
      "--model anthropic/fixture --model google/fixture --task invoice-reconciliation --concurrency 3 --max-known-cost-usd 0.5 --schedule waves.json";
    expect(parse(args, "/harness")).toMatchObject({
      modes: ["direct", "code"],
      concurrency: 3,
      maxKnownCostUsd: 0.5,
      schedulePath: "/harness/waves.json",
    });
    for (const limit of ["--concurrency 4", "--max-tokens 0", "--max-known-cost-usd NaN"]) {
      expect(() => parse(`--model openai/fixture ${limit}`)).toThrow();
    }
    for (const mode of ["auto", "direct", "code"]) {
      expect(() =>
        parse(`--model openai/fixture --task invoice-reconciliation --mode ${mode}`),
      ).toThrow("both explicit direct/code");
    }
  });

  it("rejects ambiguous selectors and output paths", () => {
    expect(() => parse("")).toThrow("At least one --model");
    expect(() => parse("--model qwen3.5:9b")).toThrow("provider/model");
    for (const arg of ["--skip-build", "constructor", "toString", "__proto__"]) {
      expect(() => parse(`--model ollama/qwen3.5:9b ${arg} 1`)).toThrow(`Unknown argument: ${arg}`);
    }
    expect(() => parse("--model fixture/model --mode code --mode code")).toThrow(
      "Duplicate --mode",
    );
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

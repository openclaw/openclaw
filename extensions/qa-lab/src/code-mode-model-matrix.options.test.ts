import { describe, expect, it } from "vitest";
import {
  parseCodeModeMatrixOptions,
  resolveCodeModeMatrixOutputDir,
} from "../../../scripts/code-mode-model-matrix.ts";

describe("Code Mode model matrix options", () => {
  it("defaults to the complete bounded matrix", () => {
    expect(parseCodeModeMatrixOptions(["--model", "ollama/qwen3.5:9b"], "/repo")).toMatchObject({
      models: ["ollama/qwen3.5:9b"],
      gatewayExecutor: "node",
      modes: ["direct", "auto", "code"],
      tasks: ["read", "dependent-read-write"],
      repetitions: 3,
      timeoutSeconds: 180,
      thinking: "off",
      repoRoot: "/repo",
    });
  });

  it("rejects invalid and duplicate extended task selectors", () => {
    for (const tasks of [["unknown"], ["dependent-chain", "dependent-chain"]]) {
      expect(() =>
        parseCodeModeMatrixOptions([
          "--model",
          "fixture/model",
          ...tasks.flatMap((task) => ["--task", task]),
        ]),
      ).toThrow(tasks.length === 1 ? "--task must be one of" : "Duplicate --task");
    }
  });

  it("keeps Gateway interviews opt-in and resolves comparison inputs independently of output storage", () => {
    const selection = ["--model", "openai/gpt-5.6-luna", "--task", "inventory-join"];
    expect(() => parseCodeModeMatrixOptions(selection, "/harness")).toThrow("--mode code");
    expect(
      parseCodeModeMatrixOptions(
        [
          ...selection,
          "--mode",
          "code",
          "--executor",
          "quickjs",
          "--runtime-dir",
          "../baseline",
          "--baseline-results",
          "artifacts/previous/results.jsonl",
          "--repetitions",
          "1",
        ],
        "/harness",
      ),
    ).toMatchObject({
      repoRoot: "/harness",
      gatewayExecutor: "quickjs",
      runtimeDir: "/baseline",
      baselineResults: "/harness/artifacts/previous/results.jsonl",
      tasks: ["inventory-join"],
      modes: ["code"],
      repetitions: 1,
    });
    expect(() =>
      parseCodeModeMatrixOptions([
        "--model",
        "fixture/model",
        "--mode",
        "code",
        "--task",
        "partial-failure",
      ]),
    ).toThrow("OpenAI models");
  });

  it.each([
    { args: ["--executor", "unknown"], error: "--executor must be node or quickjs" },
    { args: ["--executor", "node", "--executor", "quickjs"], error: "provided more than once" },
    { args: ["--executor", "quickjs", "--task", "read"], error: "only Gateway-backed tasks" },
  ])("rejects invalid or ambiguous executor selection: $args", ({ args, error }) => {
    expect(() =>
      parseCodeModeMatrixOptions([
        "--model",
        "openai/fixture",
        "--mode",
        "code",
        "--task",
        "javascript-contracts",
        ...args,
      ]),
    ).toThrow(error);
  });

  it("rejects an explicit executor when the default tasks inherit ambient config", () => {
    expect(() =>
      parseCodeModeMatrixOptions(["--model", "openai/fixture", "--executor", "node"]),
    ).toThrow("only Gateway-backed tasks");
  });

  it("rejects ambiguous selectors and output paths", () => {
    expect(() => parseCodeModeMatrixOptions([])).toThrow("At least one --model");
    expect(() => parseCodeModeMatrixOptions(["--model", "qwen3.5:9b"])).toThrow("provider/model");
    expect(() =>
      parseCodeModeMatrixOptions(["--model", "ollama/qwen3.5:9b", "--skip-build"]),
    ).toThrow("Unknown argument");
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
});

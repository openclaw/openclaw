import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCodeModeMatrixAgentExecArgs,
  buildCodeModeMatrixAgentEnv,
  classifyCodeModeMatrixModel,
} from "../../../scripts/code-mode-model-matrix.ts";

const remoteOllamaConfig = {
  models: { providers: { ollama: { baseUrl: "https://ollama.example/v1" } } },
};

const baseExecArgs = {
  fixture: { prompt: "verify" },
  matrix: {
    cell: {
      id: "cell",
      mode: "code" as const,
      model: "openai/gpt-5.4",
      repetition: 1,
      task: "read" as const,
    },
    thinking: "high",
    timeoutSeconds: 600,
  },
  runtime: { args: ["/runtime/dist/entry.js"], cwd: "/runtime" },
  stateDir: "/state",
  workspace: "/workspace",
};

describe("Code Mode model matrix provider setup", () => {
  it("adds the documented non-secret marker only for local Ollama runs", () => {
    expect(buildCodeModeMatrixAgentEnv("ollama/qwen3.5:9b", "/runtime", {})).toMatchObject({
      NODE_DISABLE_COMPILE_CACHE: "1",
      OLLAMA_API_KEY: "ollama-local",
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.join("/runtime", "dist", "extensions"),
    });
    expect(
      buildCodeModeMatrixAgentEnv("ollama/qwen3.5:9b", "/runtime", {
        OLLAMA_API_KEY: "configured-value",
      }).OLLAMA_API_KEY,
    ).toBe("configured-value");
    expect(buildCodeModeMatrixAgentEnv("huggingface/model", "/runtime", {}).OLLAMA_API_KEY).toBe(
      undefined,
    );
    expect(
      buildCodeModeMatrixAgentEnv("ollama/kimi-k2.5:cloud", "/runtime", {}).OLLAMA_API_KEY,
    ).toBeUndefined();
    expect(
      buildCodeModeMatrixAgentEnv("ollama/qwen3.5:9b", "/runtime", {}, remoteOllamaConfig)
        .OLLAMA_API_KEY,
    ).toBeUndefined();
  });

  it("disables inherited login-shell config import", () => {
    expect(
      buildCodeModeMatrixAgentEnv("openai/gpt-5.4", "/runtime", {
        OPENCLAW_LOAD_SHELL_ENV: "1",
      }).OPENCLAW_LOAD_SHELL_ENV,
    ).toBe("0");
  });

  it("limits local-model lean to configured local routes", () => {
    expect(classifyCodeModeMatrixModel("openai/gpt-5.4")).toEqual({
      localModelLean: false,
    });
    expect(classifyCodeModeMatrixModel("ollama/kimi-k2.5:cloud")).toEqual({
      localModelLean: false,
    });
    expect(classifyCodeModeMatrixModel("vllm/qwen3-8b")).toEqual({
      localModelLean: false,
    });
    expect(classifyCodeModeMatrixModel("ollama/qwen3.5:9b", remoteOllamaConfig)).toEqual({
      localModelLean: false,
    });
    expect(
      classifyCodeModeMatrixModel("openai/gpt-5.4", {
        models: { providers: { openai: { baseUrl: "http://127.0.0.1:8000/v1" } } },
      }),
    ).toEqual({ localModelLean: false });
    expect(classifyCodeModeMatrixModel("custom/model")).toEqual({ localModelLean: false });
  });

  it.each([
    ["ollama/qwen3.5:9b", "ollama", "http://host.docker.internal:11434"],
    ["lmstudio/qwen3.5:9b", "lmstudio", "http://host.docker.internal:1234"],
  ])("keeps the supported Docker-local %s route local", (model, provider, baseUrl) => {
    const config = { models: { providers: { [provider]: { baseUrl } } } };

    expect(classifyCodeModeMatrixModel(model, config)).toEqual({
      localModelLean: true,
    });
    expect(
      buildCodeModeMatrixAgentExecArgs({
        ...baseExecArgs,
        matrix: { ...baseExecArgs.matrix, cell: { ...baseExecArgs.matrix.cell, model }, config },
      }),
    ).toContain("--local-model-lean");
    if (provider === "ollama") {
      expect(buildCodeModeMatrixAgentEnv(model, "/runtime", {}, config).OLLAMA_API_KEY).toBe(
        "ollama-local",
      );
    }
  });

  it("keeps model selection explicit for diagnostics and config-owned for frontier runs", () => {
    const frontierArgs = buildCodeModeMatrixAgentExecArgs({
      ...baseExecArgs,
      configPath: "/config.json5",
      frontierEvidencePolicy: { path: "/policy.json", sha256: "b".repeat(64) },
      frontierEvidenceRunNonce: "a".repeat(64),
    });
    expect(frontierArgs).not.toContain("--local-model-lean");
    expect(frontierArgs).not.toContain("--model");
    const localArgs = buildCodeModeMatrixAgentExecArgs({
      ...baseExecArgs,
      matrix: {
        ...baseExecArgs.matrix,
        cell: { ...baseExecArgs.matrix.cell, model: "ollama/qwen3.5:9b" },
      },
    });
    expect(localArgs).toContain("--local-model-lean");
    expect(localArgs).toEqual(expect.arrayContaining(["--model", "ollama/qwen3.5:9b"]));
    expect(
      buildCodeModeMatrixAgentExecArgs({
        ...baseExecArgs,
        matrix: {
          ...baseExecArgs.matrix,
          cell: { ...baseExecArgs.matrix.cell, model: "ollama/kimi-k2.5:cloud" },
        },
      }),
    ).not.toContain("--local-model-lean");
    expect(
      buildCodeModeMatrixAgentExecArgs({
        ...baseExecArgs,
        matrix: {
          ...baseExecArgs.matrix,
          cell: { ...baseExecArgs.matrix.cell, model: "ollama/qwen3.5:9b" },
          config: remoteOllamaConfig,
        },
      }),
    ).not.toContain("--local-model-lean");
  });

  it("emits the hidden run nonce only with a frozen frontier policy", () => {
    const nonce = "a".repeat(64);
    const args = buildCodeModeMatrixAgentExecArgs({
      ...baseExecArgs,
      frontierEvidencePolicy: { path: "/policy.json", sha256: "b".repeat(64) },
      frontierEvidenceRunNonce: nonce,
    });
    expect(args).toEqual(
      expect.arrayContaining([
        "--frontier-evidence-policy",
        "/policy.json",
        "--frontier-evidence-policy-sha256",
        "b".repeat(64),
        "--frontier-evidence-run-nonce",
        nonce,
      ]),
    );
    expect(() =>
      buildCodeModeMatrixAgentExecArgs({
        ...baseExecArgs,
        frontierEvidenceRunNonce: nonce,
      }),
    ).toThrow("requires a frontier evidence policy");
  });
});

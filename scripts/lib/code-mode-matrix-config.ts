import path from "node:path";
import type { CodeModeExecutorId } from "../../src/agents/code-mode-executor-types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { mergeDeep } from "../../src/infra/deep-merge.js";
import type { CodeModeMatrixMode } from "../code-mode-model-matrix.ts";
import { matrixModelConfig } from "./code-mode-matrix-provider.ts";

export function createAgentExecMatrixConfig(model: string, thinking: string) {
  const provider = model.split("/")[0]!;
  return mergeDeep(
    {
      agents: { entries: { main: {} } },
      plugins: { allow: [provider], entries: { [provider]: { enabled: true } } },
      tools: { codeMode: { executor: "node" } },
    },
    { agents: matrixModelConfig(model, thinking) },
  );
}

export function createGatewayMatrixConfig(params: {
  root: string;
  port: number;
  token: string;
  model: string;
  thinking: string;
  mode: CodeModeMatrixMode;
  executor: CodeModeExecutorId;
  requiredTools: readonly string[];
  allowedTools: readonly string[];
  configPatch?: OpenClawConfig;
}) {
  const { root, port, token, executor, requiredTools, allowedTools } = params;
  const provider = params.model.split("/")[0]!;
  const baseConfig = {
    logging: {
      level: "info",
      consoleLevel: "info",
      consoleStyle: "pretty",
      file: path.join(root, "gateway.log"),
    },
    env: { shellEnv: { enabled: false } },
    agents: {
      defaults: {
        workspace: path.join(root, "workspace"),
        skipBootstrap: true,
        thinkingDefault: params.thinking,
        heartbeat: { every: "0m" },
        systemAgent: { agentId: "qa" },
      },
      entries: { qa: {} },
    },
    plugins: {
      allow: [
        provider,
        ...(executor === "quickjs" ? ["code-mode-quickjs"] : []),
        ...(requiredTools.length ? ["code-mode-matrix-fixture"] : []),
      ],
      slots: { memory: "none" },
      ...(requiredTools.length ? { load: { paths: [path.join(root, "fixture")] } } : {}),
      entries: {
        [provider]: { enabled: true },
        ...(executor === "quickjs" ? { "code-mode-quickjs": { enabled: true } } : {}),
        ...(requiredTools.length
          ? {
              "code-mode-matrix-fixture": {
                enabled: true,
                config: { receiptsPath: path.join(root, "receipts.jsonl") },
              },
            }
          : {}),
      },
    },
    memory: { search: { enabled: false } },
    skills: { load: { watch: false } },
    discovery: { mdns: { mode: "off" } },
    tools: {
      profile: "full",
      allow: allowedTools,
      fs: { workspaceOnly: true },
      exec: { mode: "full" },
    },
    gateway: {
      mode: "local",
      bind: "loopback",
      port,
      auth: { mode: "token", token },
      controlUi: { enabled: false },
      http: { endpoints: { responses: { enabled: true } } },
    },
  };
  // Task-specific limits cannot change the selected treatment, runtime, or model settings.
  return mergeDeep(mergeDeep(baseConfig, params.configPatch ?? {}), {
    agents: matrixModelConfig(params.model, params.thinking),
    tools: { codeMode: { enabled: params.mode === "code", executor } },
  });
}

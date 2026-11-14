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
  const patch = params.configPatch;
  const modelOverrides = [
    ...Object.values(patch?.agents?.defaults?.models ?? {}),
    ...Object.values(patch?.agents?.entries ?? {}).flatMap((agent) =>
      Object.values(agent.models ?? {}),
    ),
  ];
  if (
    patch?.tools?.codeMode !== undefined ||
    Object.values(patch?.agents?.entries ?? {}).some(
      (agent) => agent.tools?.codeMode !== undefined,
    ) ||
    modelOverrides.some((model) => model.codeMode !== undefined) ||
    Object.values(patch?.models?.providers ?? {}).some((providerConfig) =>
      providerConfig.models?.some((model) => model.compat?.codeMode !== undefined),
    )
  ) {
    throw new Error("Fixture configuration cannot override the selected Code Mode treatment.");
  }
  if (params.mode === "auto" && executor !== "node") {
    throw new Error("Gateway auto measures the default executor; do not select an executor.");
  }
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
    // An options-only object disables activation, so auto must omit the whole setting.
    ...(params.mode === "auto"
      ? {}
      : { tools: { codeMode: { enabled: params.mode === "code", executor } } }),
  });
}

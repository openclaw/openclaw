import path from "node:path";
import { resolveCodexAppServerRuntimeOptions } from "./config.js";
import type { CodexThreadStartParams } from "./protocol.js";
import type { CodexAppServerClientOptions } from "./shared-client.js";

export function createNativeSubagentClientOptions(root: string): CodexAppServerClientOptions {
  const runtime = resolveCodexAppServerRuntimeOptions({
    pluginConfig: { appServer: { homeScope: "user" } },
    env: {},
  });
  return {
    startOptions: {
      ...runtime.start,
      env: { CODEX_HOME: path.join(root, "codex-home") },
      clearEnv: ["CODEX_API_KEY", "OPENAI_API_KEY"],
    },
    agentDir: path.join(root, "agent"),
    authProfileId: null,
    timeoutMs: 120_000,
  };
}

export function createNativeSubagentThreadParams(workspace: string): CodexThreadStartParams {
  return {
    model: "gpt-5.5",
    cwd: workspace,
    approvalPolicy: "never",
    sandbox: "read-only",
    threadSource: "user",
    experimentalRawEvents: true,
    config: { "features.multi_agent": true },
  };
}

/** E2E proof for CLI runner bundle-MCP subprocess execution. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../config/config.js";
import type { CliBackendConfig } from "../config/types.js";
import { captureEnv } from "../test-utils/env.js";
import type {
  CliPreparedBackend,
  PreparedCliRunContext,
  RunCliAgentParams,
} from "./cli-runner/types.js";

// This e2e spins a real stdio MCP server plus a spawned CLI process. Keep the
// proof focused on bundle MCP config generation and subprocess execution; the
// full runCliAgent prepare graph has dedicated unit coverage and is expensive
// in cold Linux workers.
const E2E_TIMEOUT_MS = 30_000;

type BundleMcpFixture = {
  config: OpenClawConfig;
  envSnapshot: ReturnType<typeof captureEnv>;
  fakeClaudePath: string;
  fakeClaudePidPath?: string;
  pluginRoot: string;
  sessionFile: string;
  tempHome: string;
  workspaceDir: string;
};

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

function buildTestBackend(params: {
  commandPath: string;
  liveSession?: "claude-stdio";
}): CliBackendConfig {
  return {
    command: "node",
    args: [params.commandPath],
    input: "stdin",
    output: "jsonl",
    clearEnv: [],
    ...(params.liveSession ? { liveSession: params.liveSession } : {}),
  };
}

async function prepareBundleMcpExecutionContext(params: {
  backend: CliBackendConfig;
  config: OpenClawConfig;
  model: string;
  prompt: string;
  runId: string;
  sessionFile: string;
  sessionId: string;
  workspaceDir: string;
}): Promise<PreparedCliRunContext> {
  // Exercise bundle MCP config preparation while bypassing unrelated full
  // runCliAgent context assembly.
  const { prepareCliBundleMcpConfig } = await import("./cli-runner/bundle-mcp.js");
  const preparedBackend = (await prepareCliBundleMcpConfig({
    enabled: true,
    mode: "claude-config-file",
    backend: params.backend,
    workspaceDir: params.workspaceDir,
    config: params.config,
  })) as CliPreparedBackend;
  const runParams: RunCliAgentParams = {
    sessionId: params.sessionId,
    sessionFile: params.sessionFile,
    workspaceDir: params.workspaceDir,
    config: params.config,
    prompt: params.prompt,
    provider: "claude-cli",
    model: params.model,
    timeoutMs: 20_000,
    runId: params.runId,
  };

  return {
    params: runParams,
    started: Date.now(),
    workspaceDir: params.workspaceDir,
    cwd: params.workspaceDir,
    backendResolved: {
      id: "claude-cli",
      config: params.backend,
      bundleMcp: true,
      bundleMcpMode: "claude-config-file",
    },
    preparedBackend,
    reusableCliSession: { mode: "none" },
    hadSessionFile: false,
    contextEngineConfig: params.config,
    modelId: params.model,
    normalizedModel: params.model,
    systemPrompt: "Bundle MCP e2e test prompt.",
    systemPromptReport: {} as PreparedCliRunContext["systemPromptReport"],
    claudeSkillsPluginArgs: [],
    bootstrapPromptWarningLines: [],
    authEpochVersion: 1,
  };
}

async function cleanupFixture(fixture: BundleMcpFixture): Promise<void> {
  await fs.rm(fixture.tempHome, { recursive: true, force: true });
  fixture.envSnapshot.restore();
}

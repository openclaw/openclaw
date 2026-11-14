import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { assert, expect } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ExecToolDetails } from "./bash-tools.exec-result.types.js";
import type { RunEmbeddedAgentParams } from "./embedded-agent-runner/run/params.js";

export const fullGatewayExec = { host: "gateway", security: "full", ask: "off" } as const;

export function runningSession(details: ExecToolDetails) {
  assert(details.status === "running", "Expected a background process handle");
  return details;
}

export function expectCompleted(details: unknown, aggregated: string, exitCode = 0) {
  expect(details).toMatchObject({ status: "completed", aggregated, exitCode });
}

export function nodeCommand(source: string): string {
  const quote = (value: string) =>
    `'${value.replaceAll("'", process.platform === "win32" ? "''" : "'\\''")}'`;
  // CI's Bun test lane sets NODE_BIN to the installed Node runtime. These fixtures
  // exercise child-process behavior, so keep child commands on Node across runtimes.
  const node = process.env.NODE_BIN
    ? join(process.env.NODE_BIN, process.platform === "win32" ? "node.exe" : "node")
    : process.execPath;
  const command = `${quote(node)} -e ${quote(source)}`;
  return process.platform === "win32" ? `& ${command}` : command;
}

export function completionConfig(workspace: string): OpenClawConfig {
  return {
    agents: {
      entries: { main: { workspace } },
      defaults: {
        workspace,
        skipBootstrap: true,
        model: { primary: "mock-openai/gpt-5.6-luna" },
        models: { "mock-openai/gpt-5.6-luna": { agentRuntime: { id: "openclaw" } } },
      },
    },
    plugins: { enabled: false },
    skills: { load: { watch: false } },
  };
}

export async function admitModelTurn(params: RunEmbeddedAgentParams) {
  await expectDefined(params.preparedRunAdmission, "completion admission").admit(
    "gateway",
    params.runId,
  );
  await params.userTurnTranscriptRecorder?.persistApproved();
  params.onExecutionPhase?.({ phase: "model_call_started" });
  await params.onExecutionStarted?.();
  await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
}

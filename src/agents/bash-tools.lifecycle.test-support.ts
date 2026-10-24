import { expectDefined } from "@openclaw/normalization-core/expect";
import { assert, expect, vi } from "vitest";
import type { dispatchInboundMessageWithRoutedChannelDispatcher } from "../auto-reply/dispatch.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ExecToolDetails } from "./bash-tools.exec-types.js";
import type { RunEmbeddedAgentParams } from "./embedded-agent-runner/run/params.js";

export const fullGatewayExec = { host: "gateway", security: "full", ask: "off" } as const;

export function createDeferredExecDispatchMock(label = "notification") {
  return {
    dispatchInboundMessageWithRoutedChannelDispatcher: vi.fn<
      typeof dispatchInboundMessageWithRoutedChannelDispatcher
    >(async ({ replyOptions }) => {
      const lifecycle = expectDefined(replyOptions?.turnAdoptionLifecycle, `${label} lifecycle`);
      const signal = expectDefined(lifecycle.abortSignal, `${label} cancellation`);
      lifecycle.onDeferred?.();
      const onAbort = async () => {
        try {
          await lifecycle.onAbandoned?.();
        } finally {
          await lifecycle.onSettled?.();
        }
      };
      signal.addEventListener("abort", () => void onAbort(), { once: true });
      if (signal.aborted) {
        await onAbort();
      }
      return {
        deferredToActiveRun: "followup",
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 0 },
      };
    }),
  };
}

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
  const command = `${quote(process.execPath)} -e ${quote(source)}`;
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

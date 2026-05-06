import { runEmbeddedPiAgent } from "../pi-embedded-runner/run.js";
import type { RunEmbeddedPiAgentParams } from "../pi-embedded-runner/run/params.js";
import type { EmbeddedPiRunResult } from "../pi-embedded-runner/types.js";
import type { AgentRuntimeBackend, AgentRunResult, PreparedAgentRun } from "../runtime-backend.js";
import { createRunParamsFromPreparedAgentRun } from "./prepared-run-params.js";

export type PiWorkerBackendDeps = {
  runEmbeddedPiAgent: (params: RunEmbeddedPiAgentParams) => Promise<EmbeddedPiRunResult>;
};

function resultText(result: EmbeddedPiRunResult): string | undefined {
  const text = result.payloads
    ?.map((payload) => payload.text)
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n");
  return text || undefined;
}

export function createPiWorkerBackend(deps: PiWorkerBackendDeps): AgentRuntimeBackend {
  return {
    id: "pi",
    async run(preparedRun: PreparedAgentRun, context): Promise<AgentRunResult> {
      const params = createRunParamsFromPreparedAgentRun(preparedRun, context);
      const previousWorkerChild = process.env.OPENCLAW_AGENT_WORKER_CHILD;
      process.env.OPENCLAW_AGENT_WORKER_CHILD = "1";
      const result = await deps.runEmbeddedPiAgent(params).finally(() => {
        if (previousWorkerChild === undefined) {
          delete process.env.OPENCLAW_AGENT_WORKER_CHILD;
        } else {
          process.env.OPENCLAW_AGENT_WORKER_CHILD = previousWorkerChild;
        }
      });
      return {
        ok: true,
        ...(resultText(result) ? { text: resultText(result) } : {}),
        data: { embeddedPiRunResult: result as unknown as Record<string, unknown> },
      };
    },
  };
}

export const backend = createPiWorkerBackend({ runEmbeddedPiAgent });
export default backend;

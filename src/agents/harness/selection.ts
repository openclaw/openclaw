import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { CompactEmbeddedPiSessionParams } from "../pi-embedded-runner/compact.js";
import type {
  EmbeddedRunAttemptParams,
  EmbeddedRunAttemptResult,
} from "../pi-embedded-runner/run/types.js";
import { resolveEmbeddedAgentRuntime } from "../pi-embedded-runner/runtime.js";
import type { EmbeddedPiCompactResult } from "../pi-embedded-runner/types.js";
import { createPiAgentHarness } from "./builtin-pi.js";
import { listRegisteredAgentHarnesses } from "./registry.js";
import type { AgentHarness, AgentHarnessSupport } from "./types.js";

const log = createSubsystemLogger("agents/harness");

function listAvailableAgentHarnesses(): AgentHarness[] {
  return [...listRegisteredAgentHarnesses().map((entry) => entry.harness), createPiAgentHarness()];
}

function compareHarnessSupport(
  left: { harness: AgentHarness; support: AgentHarnessSupport & { supported: true } },
  right: { harness: AgentHarness; support: AgentHarnessSupport & { supported: true } },
): number {
  const priorityDelta = (right.support.priority ?? 0) - (left.support.priority ?? 0);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  return left.harness.id.localeCompare(right.harness.id);
}

export function selectAgentHarness(params: { provider: string; modelId?: string }): AgentHarness {
  const runtime = resolveEmbeddedAgentRuntime();
  const harnesses = listAvailableAgentHarnesses();
  if (runtime !== "auto") {
    const forced = harnesses.find((entry) => entry.id === runtime);
    if (forced) {
      return forced;
    }
    log.warn("requested agent harness is not registered; falling back to embedded PI backend", {
      requestedRuntime: runtime,
    });
    return createPiAgentHarness();
  }

  const supported = harnesses
    .map((harness) => ({
      harness,
      support: harness.supports({
        provider: params.provider,
        modelId: params.modelId,
        requestedRuntime: runtime,
      }),
    }))
    .filter(
      (
        entry,
      ): entry is {
        harness: AgentHarness;
        support: AgentHarnessSupport & { supported: true };
      } => entry.support.supported,
    )
    .toSorted(compareHarnessSupport);

  return supported[0]?.harness ?? createPiAgentHarness();
}

export async function runAgentHarnessAttemptWithFallback(
  params: EmbeddedRunAttemptParams,
): Promise<EmbeddedRunAttemptResult> {
  const runtime = resolveEmbeddedAgentRuntime();
  const harness = selectAgentHarness({
    provider: params.provider,
    modelId: params.modelId,
  });
  if (harness.id === "pi") {
    return harness.runAttempt(params);
  }

  try {
    return await harness.runAttempt(params);
  } catch (error) {
    if (runtime !== "auto") {
      throw error;
    }
    log.warn(`${harness.label} failed; falling back to embedded PI backend`, { error });
    return createPiAgentHarness().runAttempt(params);
  }
}

export async function maybeCompactAgentHarnessSession(
  params: CompactEmbeddedPiSessionParams,
): Promise<EmbeddedPiCompactResult | undefined> {
  const harness = selectAgentHarness({
    provider: params.provider ?? "",
    modelId: params.model,
  });
  if (!harness.compact) {
    return undefined;
  }
  return harness.compact(params);
}

import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../context-engine/host-compat.js";
import type { AgentHarness, AgentHarnessV2 } from "./types.js";

const builtInOpenClawHarnesses = new WeakSet<object>();

export function registerBuiltInOpenClawAgentHarness(harness: AgentHarness): void {
  builtInOpenClawHarnesses.add(harness);
}

/** Public runtime ids do not establish the host-owned execution boundary. */
export function isBuiltInOpenClawAgentHarness(harness: AgentHarness): boolean {
  return builtInOpenClawHarnesses.has(harness);
}

/** Shared descriptor facts; invocation stays with the factory. */
export const BUILTIN_AGENT_HARNESS_METADATA: Pick<
  AgentHarnessV2,
  "id" | "label" | "contextEngineHostCapabilities" | "supports" | "deliveryDefaults"
> = {
  id: "openclaw",
  label: "OpenClaw embedded agent",
  contextEngineHostCapabilities: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST.capabilities,
  supports: () => ({ supported: true, priority: 0 }),
};

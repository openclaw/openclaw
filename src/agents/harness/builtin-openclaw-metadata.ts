import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../context-engine/host-compat.js";
import type { AgentHarnessV2 } from "./types.js";

/** Shared descriptor facts; invocation and built-in identity stay with the factory. */
export const BUILTIN_AGENT_HARNESS_METADATA: Pick<
  AgentHarnessV2,
  "id" | "label" | "contextEngineHostCapabilities" | "supports" | "deliveryDefaults"
> = {
  id: "openclaw",
  label: "OpenClaw embedded agent",
  contextEngineHostCapabilities: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST.capabilities,
  supports: () => ({ supported: true, priority: 0 }),
};

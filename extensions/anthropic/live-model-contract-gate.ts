// Unknown model generations fall back to older request shaping. Advertise a discovered
// model only when its capability tree agrees with the contracts that would shape it.
import {
  supportsClaudeAdaptiveThinking,
  supportsClaudeNativeMaxEffort,
  supportsClaudeNativeXhighEffort,
} from "openclaw/plugin-sdk/provider-model-shared";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

function readCapabilityFlag(root: unknown, path: readonly string[]): boolean | undefined {
  let current: unknown = root;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return typeof current === "boolean" ? current : undefined;
}

const CLAUDE_CONTRACT_CAPABILITY_CHECKS = [
  {
    path: ["thinking", "types", "adaptive", "supported"],
    matches: supportsClaudeAdaptiveThinking,
  },
  { path: ["effort", "xhigh", "supported"], matches: supportsClaudeNativeXhighEffort },
  { path: ["effort", "max", "supported"], matches: supportsClaudeNativeMaxEffort },
] as const;

export function acceptsAnthropicLiveModelContract(params: {
  id: string;
  record: Record<string, unknown>;
}): boolean {
  const capabilities = params.record.capabilities;
  if (!isRecord(capabilities)) {
    return false;
  }
  const ref = { id: params.id };
  return CLAUDE_CONTRACT_CAPABILITY_CHECKS.every((check) => {
    const advertised = readCapabilityFlag(capabilities, check.path);
    return advertised !== undefined && advertised === check.matches(ref);
  });
}

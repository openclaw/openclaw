// Anthropic's /v1/models rows advertise each model's thinking and effort contract.
// Request shaping reads those facts from the catalog row (`params.claudeCapabilities`
// and `thinkingLevelMap`), so a newly listed model is selectable and shaped
// correctly before OpenClaw learns its id. Rows without them keep the id rules.
import {
  buildOpenAICompatibleLiveModels,
  type LiveModelRowProjection,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import {
  asOptionalRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

type ClaudeListedCapabilities = {
  adaptiveThinking: boolean;
  xhighEffort: boolean;
  maxEffort: boolean;
  disabledThinking?: boolean;
};

function readSupported(capabilities: unknown, path: readonly string[]): boolean | undefined {
  let current = capabilities;
  for (const key of path) {
    current = asOptionalRecord(current)?.[key];
  }
  // Anthropic reports a level the model does not offer at all (for example xhigh) as null.
  if (current === null) {
    return false;
  }
  const supported = asOptionalRecord(current)?.supported;
  return typeof supported === "boolean" ? supported : undefined;
}

function readClaudeListedCapabilities(capabilities: unknown): ClaudeListedCapabilities | undefined {
  const adaptiveThinking = readSupported(capabilities, ["thinking", "types", "adaptive"]);
  const xhighEffort = readSupported(capabilities, ["effort", "xhigh"]);
  const maxEffort = readSupported(capabilities, ["effort", "max"]);
  if (adaptiveThinking === undefined || xhighEffort === undefined || maxEffort === undefined) {
    return undefined;
  }
  const disabledThinking = readSupported(capabilities, ["thinking", "types", "disabled"]);
  return {
    adaptiveThinking,
    xhighEffort,
    maxEffort,
    ...(disabledThinking === undefined ? {} : { disabledThinking }),
  };
}

export const projectAnthropicLiveModels: LiveModelRowProjection = (rows, fallback) => {
  const listedCapabilities = new Map<string, ClaudeListedCapabilities>();
  for (const row of rows) {
    const record = asOptionalRecord(row);
    const id = normalizeOptionalString(record?.id);
    const capabilities = readClaudeListedCapabilities(record?.capabilities);
    if (id && capabilities) {
      listedCapabilities.set(id, capabilities);
    }
  }
  // The shared projection owns row filtering and what an unknown id inherits from
  // its closest shipped model (compat, thinking map, limits). Without advertised
  // capabilities only a shipped id has a known request contract.
  const models = buildOpenAICompatibleLiveModels(rows, fallback, ({ id }) =>
    listedCapabilities.has(id),
  );
  for (const [index, model] of models.entries()) {
    const claudeCapabilities = listedCapabilities.get(model.id);
    if (claudeCapabilities) {
      // Shipped rows are shared catalog objects; replace rather than mutate them.
      models[index] = {
        ...model,
        thinkingLevelMap: {
          ...model.thinkingLevelMap,
          xhigh: claudeCapabilities.xhighEffort ? "xhigh" : null,
          max: claudeCapabilities.maxEffort ? "max" : null,
        },
        params: { ...model.params, claudeCapabilities },
      };
    }
  }
  return models;
};

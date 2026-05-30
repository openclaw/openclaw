export type CodexAppServerCollaborationMode = "default" | "plan";
export type CodexAppServerReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
export type CodexAppServerReasoningMode = "execute" | "plan";

export type CodexAppServerConversationReasoningDefaults = {
  execute?: CodexAppServerReasoningEffort;
  plan?: CodexAppServerReasoningEffort;
};

export function readCodexAppServerReasoningEffort(
  value: unknown,
): CodexAppServerReasoningEffort | undefined {
  return value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh"
    ? value
    : undefined;
}

export function readCodexAppServerConversationReasoningDefaults(
  value: unknown,
): CodexAppServerConversationReasoningDefaults | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const defaults: CodexAppServerConversationReasoningDefaults = {};
  const execute = readCodexAppServerReasoningEffort(record.execute);
  const plan = readCodexAppServerReasoningEffort(record.plan);
  if (execute) {
    defaults.execute = execute;
  }
  if (plan) {
    defaults.plan = plan;
  }
  return defaults.execute || defaults.plan ? defaults : undefined;
}

export function resolveCodexAppServerReasoningMode(
  mode: CodexAppServerCollaborationMode | undefined,
): CodexAppServerReasoningMode {
  return mode === "plan" ? "plan" : "execute";
}

export function setCodexAppServerConversationReasoningDefault(
  defaults: CodexAppServerConversationReasoningDefaults | undefined,
  mode: CodexAppServerReasoningMode,
  effort: CodexAppServerReasoningEffort | undefined,
): CodexAppServerConversationReasoningDefaults | undefined {
  const next: CodexAppServerConversationReasoningDefaults = { ...defaults };
  if (effort) {
    next[mode] = effort;
  } else {
    delete next[mode];
  }
  return next.execute || next.plan ? next : undefined;
}

export function resolveCodexAppServerConversationReasoningEffort(params: {
  mode: CodexAppServerCollaborationMode | undefined;
  bindingDefaults?: CodexAppServerConversationReasoningDefaults;
  configDefaults?: CodexAppServerConversationReasoningDefaults;
  legacyReasoningEffort?: CodexAppServerReasoningEffort;
}): CodexAppServerReasoningEffort | undefined {
  const mode = resolveCodexAppServerReasoningMode(params.mode);
  return (
    params.bindingDefaults?.[mode] ?? params.legacyReasoningEffort ?? params.configDefaults?.[mode]
  );
}

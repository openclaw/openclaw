/**
 * Codex/Claude ACP model and thinking normalization used by the OpenClaw ACPX runtime.
 */
import {
  AcpRuntimeError,
  type AcpRuntime,
  type AcpRuntimeConfigOptionResult,
} from "../runtime-api.js";
import { OPENCLAW_CODEX_CONFIG_ARG } from "./codex-adapter.js";
import {
  isClaudeAcpCommand,
  isCodexAcpCommand,
  splitCommandParts,
  type AcpxAgentCommand,
} from "./command-line.js";

const CODEX_ACP_OPENCLAW_PREFIX = "openai/";
// Documented OpenClaw provider prefixes the Claude Agent SDK does not understand.
// Strip only these; a generic first-slash split would corrupt native Bedrock
// inference-profile ids and ARNs the SDK accepts as-is.
const CLAUDE_ACP_OPENCLAW_PREFIX = /^(?:anthropic|amazon-bedrock)\//i;
const CODEX_ACP_THINKING_ALIASES = new Map<string, string | undefined>([
  ["off", undefined],
  ["minimal", "low"],
  ["low", "low"],
  ["medium", "medium"],
  ["high", "high"],
  ["x-high", "xhigh"],
  ["x_high", "xhigh"],
  ["extra-high", "xhigh"],
  ["extra_high", "xhigh"],
  ["extra high", "xhigh"],
  ["xhigh", "xhigh"],
]);

type CodexAcpModelOverride = {
  model?: string;
  reasoningEffort?: string;
};

type CodexAcpModelClassification =
  | { kind: "override"; override: CodexAcpModelOverride }
  | { kind: "unsupported" };

export function failUnsupportedCodexAcpModel(rawModel: string): never {
  throw new AcpRuntimeError(
    "ACP_INVALID_RUNTIME_OPTION",
    `Codex ACP model "${rawModel}" is not supported. Use openai/<model> or <model>/<reasoning-effort>.`,
  );
}

function failUnsupportedCodexAcpThinking(rawThinking: string): never {
  throw new AcpRuntimeError(
    "ACP_INVALID_RUNTIME_OPTION",
    `Codex ACP thinking level "${rawThinking}" is not supported. Use off, minimal, low, medium, high, or xhigh.`,
  );
}

function normalizeCodexAcpReasoningEffort(rawThinking: string | undefined): string | undefined {
  const normalized = rawThinking?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (!CODEX_ACP_THINKING_ALIASES.has(normalized)) {
    failUnsupportedCodexAcpThinking(rawThinking ?? "");
  }
  return CODEX_ACP_THINKING_ALIASES.get(normalized);
}

function isCodexAcpReasoningEffortAlias(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return Boolean(normalized && CODEX_ACP_THINKING_ALIASES.has(normalized));
}

export function classifyCodexAcpModelRequest(
  rawModel: string | undefined,
  rawThinking?: string,
): CodexAcpModelClassification {
  const raw = rawModel?.trim();
  const thinkingReasoningEffort = normalizeCodexAcpReasoningEffort(rawThinking);
  const thinkingOnlyOverride = thinkingReasoningEffort
    ? { reasoningEffort: thinkingReasoningEffort }
    : undefined;
  if (!raw) {
    return { kind: "override", override: thinkingOnlyOverride ?? {} };
  }

  let value = raw;
  let hadOpenAiQualifier = false;
  if (value.toLowerCase().startsWith(CODEX_ACP_OPENCLAW_PREFIX)) {
    value = value.slice(CODEX_ACP_OPENCLAW_PREFIX.length);
    hadOpenAiQualifier = true;
  }

  let model = value.trim();
  let modelReasoningEffort: string | undefined;
  const slashIndex = value.lastIndexOf("/");
  if (slashIndex >= 0 && isCodexAcpReasoningEffortAlias(value.slice(slashIndex + 1))) {
    modelReasoningEffort = normalizeCodexAcpReasoningEffort(value.slice(slashIndex + 1));
    model = value.slice(0, slashIndex).trim();
  }

  if (hadOpenAiQualifier && (!model || model.includes("/"))) {
    failUnsupportedCodexAcpModel(raw);
  }
  if (!model || model.includes("/")) {
    return { kind: "unsupported" };
  }

  // Explicit `off` omits the override even when the model carries an effort suffix.
  const reasoningEffort = rawThinking?.trim() ? thinkingReasoningEffort : modelReasoningEffort;
  return {
    kind: "override",
    override: {
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    },
  };
}

export function withCodexSessionModel<T extends { model?: string }>(
  input: T,
  override: CodexAcpModelOverride | undefined,
): T {
  const next = { ...input };
  if (override?.model) {
    next.model = override.model;
  } else {
    delete next.model;
  }
  return next;
}

export function normalizeClaudeAcpModelOverride(rawModel: string | undefined): string | undefined {
  const raw = rawModel?.trim();
  if (!raw) {
    return undefined;
  }
  const prefix = raw.match(CLAUDE_ACP_OPENCLAW_PREFIX);
  if (!prefix) {
    return raw;
  }
  return raw.slice(prefix[0].length).trim() || undefined;
}

export type AcpxModelResult = Exclude<
  Awaited<ReturnType<NonNullable<AcpRuntime["setModel"]>>>,
  void
>;

export type AcpxProviderModelWrite = {
  model?: string;
  reasoningEffort?: string;
  /** Canonical ref reported when a genuine config snapshot accepts exactly the wire `model`. */
  acceptedModel?: string;
};

/** Codex/Claude model normalization shared by config-option and set_model writes. */
export function resolveProviderModelWrite(
  command: AcpxAgentCommand | undefined,
  requested: string,
): AcpxProviderModelWrite | undefined {
  if (isCodexAcpCommand(command)) {
    const classification = classifyCodexAcpModelRequest(requested);
    if (classification.kind === "unsupported") {
      failUnsupportedCodexAcpModel(requested);
    }
    const { override } = classification;
    return override.model && requested.trim().toLowerCase().startsWith(CODEX_ACP_OPENCLAW_PREFIX)
      ? { ...override, acceptedModel: `${CODEX_ACP_OPENCLAW_PREFIX}${override.model}` }
      : override;
  }
  if (isClaudeAcpCommand(command)) {
    return { model: normalizeClaudeAcpModelOverride(requested) ?? requested };
  }
  return undefined;
}

/** Effort stays its own option; only the exact normalized wire model maps back to its ref. */
export function withAcceptedModelRef<T extends Partial<AcpRuntimeConfigOptionResult>>(
  result: T | void,
  plan: AcpxProviderModelWrite,
): T | void {
  const { model, acceptedModel } = plan;
  if (!result || !model || !acceptedModel) {
    return result;
  }
  const { configOptions } = result;
  if (!configOptions) {
    return result;
  }
  return {
    ...result,
    configOptions: configOptions.map((option) =>
      (option.id === "model" || option.category === "model") && option.currentValue === model
        ? Object.assign({}, option, { currentValue: acceptedModel })
        : option,
    ),
  };
}

export function appendCodexAcpConfigOverrides(
  command: AcpxAgentCommand,
  override: CodexAcpModelOverride,
): AcpxAgentCommand {
  const config = {
    ...(override.model ? { model: override.model } : {}),
    ...(override.reasoningEffort ? { model_reasoning_effort: override.reasoningEffort } : {}),
  };
  if (Object.keys(config).length === 0) {
    return command;
  }
  return [...splitCommandParts(command), OPENCLAW_CODEX_CONFIG_ARG, JSON.stringify(config)];
}

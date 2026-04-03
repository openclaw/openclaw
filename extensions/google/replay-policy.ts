import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  AnyAgentTool,
  ProviderNormalizeToolSchemasContext,
  ProviderReasoningOutputMode,
  ProviderReplayPolicy,
  ProviderReplaySessionState,
  ProviderSanitizeReplayHistoryContext,
  ProviderToolSchemaDiagnostic,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  cleanSchemaForGemini,
  findUnsupportedSchemaKeywords,
  GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS,
} from "openclaw/plugin-sdk/provider-tools";

const GOOGLE_TURN_ORDERING_CUSTOM_TYPE = "google-turn-ordering-bootstrap";
const GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT = "(session bootstrap)";

function sanitizeGoogleAssistantFirstOrdering(messages: AgentMessage[]): AgentMessage[] {
  const first = messages[0] as { role?: unknown; content?: unknown } | undefined;
  const role = first?.role;
  const content = first?.content;
  if (
    role === "user" &&
    typeof content === "string" &&
    content.trim() === GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT
  ) {
    return messages;
  }
  if (role !== "assistant") {
    return messages;
  }

  const bootstrap: AgentMessage = {
    role: "user",
    content: GOOGLE_TURN_ORDER_BOOTSTRAP_TEXT,
    timestamp: Date.now(),
  } as AgentMessage;

  return [bootstrap, ...messages];
}

function hasGoogleTurnOrderingMarker(sessionState: ProviderReplaySessionState): boolean {
  return sessionState
    .getCustomEntries()
    .some((entry) => entry.customType === GOOGLE_TURN_ORDERING_CUSTOM_TYPE);
}

function markGoogleTurnOrderingMarker(sessionState: ProviderReplaySessionState): void {
  sessionState.appendCustomEntry(GOOGLE_TURN_ORDERING_CUSTOM_TYPE, {
    timestamp: Date.now(),
  });
}

/**
 * Returns the provider-owned replay policy for Google Gemini transports.
 */
export function buildGoogleReplayPolicy(): ProviderReplayPolicy {
  return {
    sanitizeMode: "full",
    sanitizeToolCallIds: true,
    toolCallIdMode: "strict",
    sanitizeThoughtSignatures: {
      allowBase64Only: true,
      includeCamelCase: true,
    },
    repairToolUseResultPairing: true,
    applyAssistantFirstOrderingFix: true,
    validateGeminiTurns: true,
    validateAnthropicTurns: false,
    allowSyntheticToolResults: true,
  };
}

/**
 * Returns the provider-owned reasoning output mode for Google Gemini transports.
 */
export function resolveGoogleReasoningOutputMode(): ProviderReasoningOutputMode {
  return "tagged";
}

/**
 * Applies the provider-owned replay ordering fix for Gemini transports.
 */
export function sanitizeGoogleReplayHistory(
  ctx: ProviderSanitizeReplayHistoryContext,
): AgentMessage[] {
  const messages = sanitizeGoogleAssistantFirstOrdering(ctx.messages);
  if (
    messages !== ctx.messages &&
    ctx.sessionState &&
    !hasGoogleTurnOrderingMarker(ctx.sessionState)
  ) {
    markGoogleTurnOrderingMarker(ctx.sessionState);
  }
  return messages;
}

/**
 * Normalizes Gemini CLI tool schemas to the restricted JSON Schema subset
 * accepted by the Cloud Code Assist transport.
 */
export function normalizeGoogleGeminiCliToolSchemas(
  ctx: ProviderNormalizeToolSchemasContext,
): AnyAgentTool[] {
  return ctx.tools.map((tool) => {
    if (!tool.parameters || typeof tool.parameters !== "object") {
      return tool;
    }
    return {
      ...tool,
      parameters: cleanSchemaForGemini(tool.parameters as Record<string, unknown>),
    };
  });
}

/**
 * Reports any remaining Gemini CLI schema violations after normalization.
 */
export function inspectGoogleGeminiCliToolSchemas(
  ctx: ProviderNormalizeToolSchemasContext,
): ProviderToolSchemaDiagnostic[] {
  return ctx.tools.flatMap((tool, toolIndex) => {
    const violations = findUnsupportedSchemaKeywords(
      tool.parameters,
      `${tool.name}.parameters`,
      GEMINI_UNSUPPORTED_SCHEMA_KEYWORDS,
    );
    if (violations.length === 0) {
      return [];
    }
    return [{ toolName: tool.name, toolIndex, violations }];
  });
}

import type { MessageMetadata } from "@slack/types";

export const OPENCLAW_GATEWAY_FAILURE_METADATA_EVENT_TYPE = "openclaw_gateway_failure";
const OPENCLAW_GATEWAY_FAILURE_METADATA_SOURCE = "openclaw";
const OPENCLAW_GATEWAY_FAILURE_METADATA_SCHEMA_VERSION = 1;

const OPENCLAW_GATEWAY_FAILURE_PREFIXES = [
  {
    kind: "agent_failed_before_reply",
    prefixes: ["\u26a0\ufe0f Agent failed before reply:", ":warning: Agent failed before reply:"],
  },
  {
    kind: "model_login_expired",
    prefixes: [
      "\u26a0\ufe0f Model login expired on the gateway",
      ":warning: Model login expired on the gateway",
    ],
  },
  {
    kind: "missing_api_key",
    prefixes: ["\u26a0\ufe0f Missing API key for", ":warning: Missing API key for"],
  },
] as const;

type OpenClawGatewayFailureKind = (typeof OPENCLAW_GATEWAY_FAILURE_PREFIXES)[number]["kind"];

const OPENCLAW_GATEWAY_FAILURE_KINDS = new Set<string>(
  OPENCLAW_GATEWAY_FAILURE_PREFIXES.map((entry) => entry.kind),
);

function resolveOpenClawGatewayFailureKind(
  text: string | undefined,
): OpenClawGatewayFailureKind | null {
  const trimmed = text?.trimStart();
  if (!trimmed) {
    return null;
  }
  for (const entry of OPENCLAW_GATEWAY_FAILURE_PREFIXES) {
    if (entry.prefixes.some((prefix) => trimmed.startsWith(prefix))) {
      return entry.kind;
    }
  }
  return null;
}

export function resolveOpenClawGatewayFailureMetadata(
  text: string | undefined,
): MessageMetadata | undefined {
  const kind = resolveOpenClawGatewayFailureKind(text);
  if (!kind) {
    return undefined;
  }
  return {
    event_type: OPENCLAW_GATEWAY_FAILURE_METADATA_EVENT_TYPE,
    event_payload: {
      source: OPENCLAW_GATEWAY_FAILURE_METADATA_SOURCE,
      kind,
      schema_version: OPENCLAW_GATEWAY_FAILURE_METADATA_SCHEMA_VERSION,
    },
  };
}

export function isOpenClawGatewayFailureMetadata(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return false;
  }
  const eventType = (metadata as { event_type?: unknown }).event_type;
  if (eventType !== OPENCLAW_GATEWAY_FAILURE_METADATA_EVENT_TYPE) {
    return false;
  }
  const eventPayload = (metadata as { event_payload?: unknown }).event_payload;
  if (!eventPayload || typeof eventPayload !== "object" || Array.isArray(eventPayload)) {
    return false;
  }
  const payload = eventPayload as { source?: unknown; kind?: unknown };
  return (
    payload.source === OPENCLAW_GATEWAY_FAILURE_METADATA_SOURCE &&
    typeof payload.kind === "string" &&
    OPENCLAW_GATEWAY_FAILURE_KINDS.has(payload.kind)
  );
}

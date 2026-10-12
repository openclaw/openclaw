import {
  escapeRuntimeContextFooter,
  hasRuntimeContextMarker,
  isRuntimeContextMessage,
  labelRuntimeContextText,
  RUNTIME_CONTEXT_HEADER,
  setRuntimeContextRetention,
  type Context,
} from "../../../llm/types.js";
import {
  OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
  STEERING_RUNTIME_CONTEXT,
  SYSTEM_UPDATE_MESSAGE_CUSTOM_TYPE,
  RUNTIME_EVENT_USER_PROMPT,
  projectRuntimeContextFragments,
  type CurrentInboundPromptContext,
  type RuntimeContextFragment,
} from "../../internal-runtime-context.js";
import type { AgentMessage } from "../../runtime/index.js";

const RETAIN_STEERING_RUNTIME_CONTEXT = Symbol.for("openclaw.retainSteeringRuntimeContext");

/** Configure transcript retention for steering-owned runtime context. */
export function setSteeringRuntimeContextRetention(session: object, retain: boolean): void {
  Reflect.set(session, RETAIN_STEERING_RUNTIME_CONTEXT, retain);
}

export function shouldRetainSteeringRuntimeContext(session: object): boolean {
  return Reflect.get(session, RETAIN_STEERING_RUNTIME_CONTEXT) === true;
}

/** Hidden custom transcript message that carries runtime context into model conversion. */
export type RuntimeContextCustomMessage = {
  role: "custom";
  customType: string;
  content: string;
  display: false;
  details:
    | {
        source: "openclaw-runtime-context";
        runtimeContextCarrier: true;
        fragments?: RuntimeContextFragment[];
      }
    | { kind: "prompt-update" | "runtime-context"; turnScoped: boolean; fragments?: never };
  timestamp: number;
};

/** Adds turn context without separating an inline prompt header from its user text. */
export function appendCurrentInboundContext(
  context: CurrentInboundPromptContext | undefined,
  fragments: RuntimeContextFragment[],
  legacyText = fragments.map((fragment) => fragment.text).join("\n\n"),
): CurrentInboundPromptContext {
  // A space joiner binds the existing context's trailing header to the user body.
  // Later additions must precede that context in both full and resumed prompts.
  const inline = context?.promptJoiner === " ";
  const append = (text?: string) =>
    (inline ? [legacyText, text] : [text, legacyText]).filter(Boolean).join("\n\n");
  return {
    ...context,
    text: append(context?.text),
    ...(context?.resumableText !== undefined
      ? { resumableText: append(context.resumableText) }
      : {}),
    fragments: [
      ...(context?.fragments ??
        (context?.text ? [{ kind: "conversation-data" as const, text: context.text }] : [])),
      ...fragments,
    ],
  };
}

export function buildCurrentInboundPrompt(params: {
  context: CurrentInboundPromptContext | undefined;
  prompt: string;
  preferResumableText?: boolean;
}): string {
  const contextText =
    params.preferResumableText === true
      ? (params.context?.resumableText ?? params.context?.text)
      : params.context?.text;
  const prefix = contextText?.trim() ?? "";
  return [prefix, params.prompt].filter(Boolean).join(params.context?.promptJoiner ?? "\n\n");
}

/** Bind context to its queued user turn without changing user-authored bytes. */
export function attachSteeringRuntimeContext(
  message: AgentMessage,
  context: CurrentInboundPromptContext | undefined,
): void {
  if (!context) {
    return;
  }
  const fragments = (
    context.fragments ?? [{ kind: "conversation-data" as const, text: context.text }]
  ).filter((fragment) => fragment.text.trim());
  const runtimeContext = buildRuntimeContextCustomMessage(
    projectRuntimeContextFragments(fragments),
    fragments,
  );
  if (!runtimeContext) {
    return;
  }
  // The enumerable symbol survives in-memory message copies but never enters
  // transcript JSON or provider payloads. Queue cancellation stays atomic.
  for (const target of [runtimeContext, message]) {
    Object.defineProperty(target, STEERING_RUNTIME_CONTEXT, {
      configurable: true,
      enumerable: true,
      value: runtimeContext,
    });
  }
}

/** Materialize an attached carrier immediately before its owning user turn. */
export function materializeSteeringRuntimeContext(messages: AgentMessage[]): AgentMessage[] {
  if (!messages.some((message) => Reflect.get(message, STEERING_RUNTIME_CONTEXT))) {
    return messages;
  }
  const projected: AgentMessage[] = [];
  for (const message of messages) {
    const runtimeContext = Reflect.get(message, STEERING_RUNTIME_CONTEXT);
    if (runtimeContext && projected.at(-1) !== runtimeContext) {
      projected.push(runtimeContext);
    }
    projected.push(message);
  }
  return projected;
}

/** Returns the carrier bound to this queued user turn. */
export function getSteeringRuntimeContext(
  message: AgentMessage,
): RuntimeContextCustomMessage | undefined {
  return Reflect.get(message, STEERING_RUNTIME_CONTEXT);
}

/** Selects explicit producer context without interpreting any prompt text as provenance. */
export function resolveRuntimeContextPromptParts(params: {
  effectivePrompt: string;
  transcriptPrompt?: string;
  fragments?: RuntimeContextFragment[];
  allowRuntimeOnly?: boolean;
}) {
  const fragments = params.fragments?.filter((fragment) => fragment.text.trim());
  const runtimeContext = fragments?.map((fragment) => fragment.text).join("\n\n") ?? "";
  const transcriptPrompt = params.transcriptPrompt ?? params.effectivePrompt;
  const runtimeOnly =
    !transcriptPrompt.trim() && Boolean(runtimeContext) && params.allowRuntimeOnly !== false;
  const prompt = runtimeOnly
    ? RUNTIME_EVENT_USER_PROMPT
    : transcriptPrompt || params.effectivePrompt;
  return {
    prompt,
    modelPrompt:
      params.effectivePrompt && params.effectivePrompt !== prompt
        ? params.effectivePrompt
        : undefined,
    runtimeContext: runtimeContext || undefined,
    ...(runtimeOnly ? { runtimeOnly: true } : {}),
  };
}

export function applyRuntimeContextCarrierRetention(
  messages: Context["messages"],
  appendOnlyRuntimeContext: boolean | undefined,
): void {
  for (const message of messages) {
    if (isRuntimeContextMessage(message)) {
      setRuntimeContextRetention(message, appendOnlyRuntimeContext);
    }
  }
}

export function buildRuntimeContextCustomMessage(
  runtimeContext: string | undefined,
  fragments?: RuntimeContextFragment[],
  inHistorySystemUpdates = false,
): RuntimeContextCustomMessage | undefined {
  const trimmedRuntimeContext = runtimeContext?.trim();
  if (!trimmedRuntimeContext) {
    return undefined;
  }
  if (inHistorySystemUpdates) {
    return buildSystemUpdateMessage(
      fragments?.length ? projectRuntimeContextFragments(fragments) : trimmedRuntimeContext,
      "runtime-context",
      true,
    );
  }
  return buildContextCustomMessage(trimmedRuntimeContext, OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE, {
    source: "openclaw-runtime-context",
    runtimeContextCarrier: true,
    ...(fragments?.length ? { fragments } : {}),
  });
}

export function buildSystemUpdateMessage(
  content: string,
  kind: "prompt-update" | "runtime-context",
  turnScoped: boolean,
): RuntimeContextCustomMessage {
  return buildContextCustomMessage(content, SYSTEM_UPDATE_MESSAGE_CUSTOM_TYPE, {
    kind,
    turnScoped,
  });
}

function buildContextCustomMessage(
  content: string,
  customType: string,
  details: RuntimeContextCustomMessage["details"],
): RuntimeContextCustomMessage {
  return { role: "custom", customType, content, display: false, details, timestamp: Date.now() };
}

/** Project per-request instructions into the transient carrier without changing history. */
export function prependRuntimeContextForModel(
  messages: Context["messages"],
  runtimeContext: string,
): Context["messages"] {
  if (!runtimeContext.trim()) {
    return messages;
  }
  const carrierIndex = messages.findIndex(hasRuntimeContextMarker);
  const carrier = messages[carrierIndex];
  const prepend = (text: string) =>
    text.startsWith(`${RUNTIME_CONTEXT_HEADER}\n`)
      ? `${RUNTIME_CONTEXT_HEADER}\n${escapeRuntimeContextFooter(runtimeContext)}\n\n${text.slice(RUNTIME_CONTEXT_HEADER.length + 1)}`
      : labelRuntimeContextText([runtimeContext, text].filter(Boolean).join("\n\n"));
  if (!carrier || carrier.role !== "user" || !hasRuntimeContextMarker(carrier)) {
    return [
      ...messages,
      {
        role: "user",
        content: prepend(""),
        timestamp: messages.at(-1)?.timestamp ?? 0,
        runtimeContext: {},
      },
    ];
  }
  const content = carrier.content;
  const firstTextIndex =
    typeof content === "string" ? -1 : content.findIndex((part) => part.type === "text");
  const updatedContent: typeof content =
    typeof content === "string"
      ? prepend(content)
      : firstTextIndex < 0
        ? [{ type: "text", text: prepend("") }, ...content]
        : content.map((part, index) =>
            index === firstTextIndex && part.type === "text"
              ? Object.assign({}, part, { text: prepend(part.text) })
              : part,
          );
  return messages.with(carrierIndex, { ...carrier, content: updatedContent });
}

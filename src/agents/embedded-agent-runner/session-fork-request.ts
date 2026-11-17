import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Model } from "../../llm/types.js";
import { gateAgentToolExecution } from "../agent-tool-availability.js";
import { copyAgentToolMetadata } from "../agent-tool-metadata.js";
import type { AnyAgentTool } from "../tools/common.js";
import { isCurrentEmbeddedRunAttachment } from "./run-state.js";
import { resolveActiveEmbeddedRunBySessionFile } from "./runs.js";
import { sameToolParameters } from "./session-tool-definition.js";

const TOOL_CALL_ID_KEYS = new Set(["id", "call_id", "tool_use_id", "tool_call_id"]);
// A tool-free fork sets tool_choice none, which also stops provider-hosted tools (for example
// web search) that run before any client-side gate sees them.
const TOOL_CHOICE_NONE = new Map<Model["api"], "object" | "string">([
  ["anthropic-messages", "object"],
  ["openai-responses", "string"],
  ["openai-chatgpt-responses", "string"],
  ["openai-completions", "string"],
]);
const OUTPUT_LIMIT_KEYS = ["max_tokens", "max_output_tokens", "max_completion_tokens"] as const;

/**
 * Cache checkpoints place a request rather than content; only the parent's survive replay,
 * as nothing reads one the fork writes past the parent's input. `id` maps tool-call IDs.
 */
const serializeItem = (item: unknown, id: (value: string) => unknown, textBlocks = false) =>
  JSON.stringify(item, (key, value: unknown) => {
    if (key === "cache_control") {
      return undefined;
    }
    if (typeof value === "string" && TOOL_CALL_ID_KEYS.has(key)) {
      return id(value);
    }
    return textBlocks && key === "content" && typeof value === "string"
      ? [{ type: "text", text: value }]
      : value;
  });

/**
 * The parent's stream may rewrite tool-call IDs and collapse one text block to a string
 * after the history the fork rebuilds, so items compare with IDs by order of first use.
 */
function compareItems(items: unknown[]) {
  const ids: string[] = [];
  const keys = items.map((item) =>
    serializeItem(
      item,
      (value) => (ids.includes(value) ? ids.indexOf(value) : ids.push(value) - 1),
      true,
    ),
  );
  return { ids, keys };
}

const isPlainContainer = (value: unknown): value is Record<string, unknown> | unknown[] =>
  Array.isArray(value) ||
  (typeof value === "object" &&
    value !== null &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)));

/** Signals, fetch overrides and class instances; JSON null and primitives are data. */
const isTransportHandle = (value: unknown) =>
  typeof value === "function" ||
  (typeof value === "object" && value !== null && !isPlainContainer(value));

/**
 * Copies the parent's request data. Transport handles that ride in request configs (the
 * Google SDK's abort signal, fetch overrides) belong to each request, so the fork's own
 * value at the same path replaces them.
 */
function replayData(sent: unknown, own: unknown): unknown {
  if (isTransportHandle(sent)) {
    return own;
  }
  if (!isPlainContainer(sent)) {
    return sent;
  }
  const ownRecord: Record<string, unknown> = isPlainContainer(own) ? Object(own) : {};
  if (Array.isArray(sent)) {
    return sent.map((item, index) => replayData(item, ownRecord[index]));
  }
  const copy: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(sent)) {
    const replayed = replayData(value, ownRecord[name]);
    if (replayed !== undefined) {
      copy[name] = replayed;
    }
  }
  for (const [name, value] of Object.entries(ownRecord)) {
    if (!(name in copy) && isTransportHandle(value)) {
      copy[name] = value;
    }
  }
  return copy;
}

/**
 * Replays the parent's last prepared request, then the fork's own items. Its own request is
 * rebuilt from history, whose bytes and order may differ from what the parent sent. Keeps
 * the rebuilt request when the parent sent items the fork lacks or only a continuation delta.
 */
function replayPreparedRequest(
  payload: Record<string, unknown>,
  prepared: Record<string, unknown>,
): void {
  const key = ["input", "messages", "contents"].find((name) => Array.isArray(payload[name]));
  if (!key) {
    return;
  }
  const ownItems = payload[key];
  const sentItems = prepared[key];
  if (
    !Array.isArray(ownItems) ||
    !Array.isArray(sentItems) ||
    prepared.previous_response_id != null
  ) {
    return;
  }
  const parent = compareItems(sentItems);
  const own = compareItems(ownItems);
  const unmatched = new Map<string, number>();
  for (const item of parent.keys) {
    unmatched.set(item, (unmatched.get(item) ?? 0) + 1);
  }
  const suffix = ownItems.filter((_, index) => {
    const count = unmatched.get(own.keys[index]!);
    if (count) {
      unmatched.set(own.keys[index]!, count - 1);
    }
    return !count;
  });
  if ([...unmatched.values()].some(Boolean)) {
    return;
  }
  // Matched items share ID order, so the suffix spells the parent's IDs as the parent did.
  const spelling = new Map(parent.ids.map((id, index) => [own.ids[index], id]));
  const replay = replayData({ ...prepared, [key]: [] }, payload);
  for (const name of Object.keys(payload)) {
    delete payload[name];
  }
  Object.assign(payload, replay, {
    [key]: [
      ...sentItems.map((item) => replayData(item, undefined)),
      ...suffix.map((item) =>
        JSON.parse(serializeItem(item, (value) => spelling.get(value) ?? value)),
      ),
    ],
  });
}

/** Function declarations the run can gate; anything else may run at the provider. */
function isClientTool(tool: unknown): boolean {
  if (!isRecord(tool)) {
    return false;
  }
  if (tool.type === undefined) {
    // Anthropic client tools, or a Gemini functionDeclarations group.
    return (
      "input_schema" in tool || Object.keys(tool).every((key) => key === "functionDeclarations")
    );
  }
  return tool.type === "function" || tool.type === "custom";
}

// Gemini SDK requests carry tools in config.
const requestTools = (payload: Record<string, unknown>) =>
  [payload.tools, isRecord(payload.config) && payload.config.tools].flatMap((list) =>
    Array.isArray(list) ? list : [],
  );

/** Declared function names: top-level, Chat Completions `function`, or Gemini groups. */
function requestToolNames(payload: Record<string, unknown>): Set<unknown> {
  return new Set(
    requestTools(payload).flatMap((tool) =>
      !isRecord(tool)
        ? []
        : Array.isArray(tool.functionDeclarations)
          ? tool.functionDeclarations.map((entry) => isRecord(entry) && entry.name)
          : [isRecord(tool.function) ? tool.function.name : tool.name],
    ),
  );
}

/** The source session's last checkpointed system prompt and tool definitions. */
export type SessionForkPin = {
  prefix: string;
  tools: Array<Pick<AnyAgentTool, "name" | "description" | "parameters">>;
};

export type SessionForkRequest = {
  /** The source session's last prepared provider request, while its run is live on this route. */
  preparedRequest?: Record<string, unknown>;
  /** The source's pin: the fork's own requests send this prompt and tool list unchanged. */
  pin?: SessionForkPin;
  /** The caller set its own output limit; keep it over the parent's. */
  ownOutputLimit: boolean;
};

/**
 * The source's pinned tool definitions in their sent order, then any tool only the fork
 * built (a plugin's granted tool). A pinned tool the fork did not build refuses its calls.
 */
export function listSessionForkTools(pin: SessionForkPin, tools: AnyAgentTool[]): AnyAgentTool[] {
  const built = new Map(tools.map((tool) => [tool.name, tool]));
  return [
    ...pin.tools.map((definition) => {
      const tool = built.get(definition.name);
      if (!tool) {
        return gateAgentToolExecution(
          {
            ...definition,
            label: definition.name,
            execute: async () => ({ content: [], details: {} }),
          },
          `${definition.name} is not available in this background run. Do not retry ${definition.name}.`,
        );
      }
      return sameToolParameters(definition.parameters, tool.parameters)
        ? copyAgentToolMetadata(tool, { ...tool, description: definition.description })
        : tool;
    }),
    ...tools.filter((tool) => !pin.tools.some((definition) => definition.name === tool.name)),
  ];
}

/**
 * Makes one fork request the parent's request plus the fork's own suffix. The parent's tools
 * stay listed and the run gates which may execute (`allowedTools`); with none allowed,
 * tool_choice none also stops provider-hosted tools. The rebuilt request is sent instead when
 * the parent never listed a tool the fork may run, or listed a provider-hosted tool that
 * would run before the gate.
 */
export function applySessionForkRequest(
  payload: Record<string, unknown>,
  fork: SessionForkRequest,
  run: { api: Model["api"]; allowedTools: readonly string[] },
): void {
  const { api, allowedTools } = run;
  const prepared = fork.preparedRequest;
  const toolFree = allowedTools.length === 0;
  const listed = prepared && !toolFree ? requestToolNames(prepared) : undefined;
  if (
    prepared &&
    (toolFree ||
      (requestTools(prepared).every(isClientTool) &&
        allowedTools.every((name) => listed?.has(name))))
  ) {
    const own = OUTPUT_LIMIT_KEYS.map((key) => [key, payload[key]] as const);
    replayPreparedRequest(payload, prepared);
    if (fork.ownOutputLimit) {
      for (const [key, value] of own) {
        if (value === undefined) {
          delete payload[key];
        } else {
          payload[key] = value;
        }
      }
    }
  }
  if (!toolFree) {
    return;
  }
  const shape = TOOL_CHOICE_NONE.get(api);
  if (!shape) {
    if (!requestTools(payload).every(isClientTool)) {
      throw new Error(
        `Session forks cannot disable provider-hosted tools on provider API ${api}. Remove hosted tools from this model's requests to fork it.`,
      );
    }
  } else if (Array.isArray(payload.tools) && payload.tools.length > 0) {
    payload.tool_choice = shape === "object" ? { type: "none" } : "none";
  } else {
    delete payload.tool_choice;
  }
}

/**
 * The live parent run's last prepared request and prompt-cache key, when the source session's
 * run is current on this model. A settled parent has none: the fork's own request then restores
 * the session's pinned system prompt and tool definitions from its transcript.
 */
export function readLiveSessionForkRequest(params: {
  sessionKey: string;
  model: { provider: string; model: string };
}): { promptCacheKey?: string; preparedRequest?: Record<string, unknown> } | undefined {
  // SQLite-backed runs register under the canonical key, not the legacy transcript path. A
  // request from a later generation of the key cannot match the fork's history, so the
  // replay falls back to the fork's rebuilt request.
  const attachment = resolveActiveEmbeddedRunBySessionFile(params.sessionKey);
  const live =
    attachment && isCurrentEmbeddedRunAttachment(attachment)
      ? attachment.handle.readSessionForkContext?.()
      : undefined;
  const sameRoute = (model: Model | undefined) =>
    model?.provider === params.model.provider && model.id === params.model.model;
  if (!live || !sameRoute(live.model)) {
    return undefined;
  }
  const prepared = live.preparedRequest;
  return {
    ...(live.promptCacheKey ? { promptCacheKey: live.promptCacheKey } : {}),
    ...(prepared && sameRoute(prepared.model) ? { preparedRequest: prepared.body } : {}),
  };
}

import type { CachedSnapshot, IKernel, IndexMap, Operation } from "@aotui/runtime";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { OPENCLAW_AOTUI_SYSTEM_INSTRUCTION } from "./system-instruction.js";
import type {
  AotuiInjectedMessageMeta,
  AotuiSnapshotProjector,
  AotuiToolBinding,
  DesktopRecord,
} from "./types.js";

type OperationParamLike = {
  name: string;
  type?: string;
  required?: boolean;
  description?: string;
  options?: readonly string[];
};

type OperationEntryLike = {
  type: "operation";
  appId: string;
  operation: {
    id: string;
    displayName?: string;
    params?: OperationParamLike[];
  };
};

type TypeToolEntryLike = {
  description?: string;
  params?: OperationParamLike[];
  appId?: string;
  appName?: string;
  viewType?: string;
  toolName?: string;
};

type RuntimeToolDefinitionLike = {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

const AOTUI_METADATA_KEY = "aotui";
const OPENCLAW_DESKTOP_TOOL_PREFIX = "desktop-";
const RUNTIME_SYSTEM_TOOL_PREFIX = "system-";

function createInjectedMessage(params: {
  role: "system" | "user" | "assistant";
  content: string;
  meta: DesktopRecord;
  snapshotId: string;
  kind: AotuiInjectedMessageMeta["kind"];
  timestamp: number;
  viewId?: string;
}): AgentMessage {
  return {
    role: params.role,
    content: params.content,
    timestamp: params.timestamp,
    metadata: {
      [AOTUI_METADATA_KEY]: createInjectedMetadata(
        params.meta,
        params.snapshotId,
        params.kind,
        params.viewId,
      ),
    },
  } as unknown as AgentMessage;
}

function createInjectedMetadata(
  meta: DesktopRecord,
  snapshotId: string,
  kind: AotuiInjectedMessageMeta["kind"],
  viewId?: string,
): AotuiInjectedMessageMeta {
  return {
    aotui: true,
    desktopKey: meta.desktopKey,
    snapshotId,
    kind,
    ...(viewId ? { viewId } : {}),
  };
}

function isOperationEntry(entry: unknown): entry is OperationEntryLike {
  return (
    typeof entry === "object" &&
    entry !== null &&
    (entry as OperationEntryLike).type === "operation" &&
    typeof (entry as OperationEntryLike).appId === "string" &&
    typeof (entry as OperationEntryLike).operation?.id === "string"
  );
}

function isTypeToolEntry(entry: unknown): entry is TypeToolEntryLike {
  return typeof entry === "object" && entry !== null;
}

function normalizeJsonSchemaType(paramType?: string): string {
  if (!paramType || paramType === "enum" || paramType === "reference") {
    return "string";
  }

  return paramType;
}

function convertParamsToSchema(params: OperationParamLike[] | undefined): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const param of params ?? []) {
    const paramType = param.type ?? "string";
    const property: Record<string, unknown> = {
      type: normalizeJsonSchemaType(paramType),
    };

    if (param.description) {
      property.description = param.description;
    }
    if (paramType === "enum" && Array.isArray(param.options)) {
      property.enum = [...param.options];
    }

    properties[param.name] = property;
    if (param.required) {
      required.push(param.name);
    }
  }

  return {
    type: "object",
    properties,
    required,
    additionalProperties: false,
  };
}

function createViewOperation(meta: {
  appId: string;
  viewId?: string;
  operationName: string;
}): Operation {
  return {
    context: {
      appId: meta.appId as Operation["context"]["appId"],
      snapshotId: "latest" as Operation["context"]["snapshotId"],
      ...(meta.viewId ? { viewId: meta.viewId as Operation["context"]["viewId"] } : {}),
    },
    name: meta.operationName as Operation["name"],
    args: {},
  };
}

function normalizeDesktopInstructionContent(content: string): string {
  return content
    .replaceAll("system-open_app", "desktop-open_app")
    .replaceAll("system-close_app", "desktop-close_app")
    .replaceAll("system-dismount_view", "desktop-dismount_view")
    .replaceAll("`open_app(", "`desktop-open_app(")
    .replaceAll("`close_app(", "`desktop-close_app(")
    .replaceAll("`dismount_view(", "`desktop-dismount_view(");
}

type DynamicObservationEntry = {
  id: string;
  markup: string;
  kind: "app_state" | "view_state";
  timestamp?: number;
};

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function wrapDesktopState(markup: string): string {
  const trimmed = markup.trim();
  if (trimmed.startsWith("<desktop")) {
    return trimmed;
  }
  return `<desktop>\n${trimmed}\n</desktop>`;
}

function wrapAppMarkup(params: { appId: string; appName?: string; markup: string }): string {
  const appName = params.appName?.trim() || params.appId;
  return (
    `<app id="${escapeAttribute(params.appId)}" name="${escapeAttribute(appName)}">\n` +
    `${params.markup}\n` +
    `</app>`
  );
}

function wrapViewMarkup(params: {
  appId: string;
  appName?: string;
  viewId: string;
  viewType?: string;
  viewName?: string;
  markup: string;
}): string {
  const trimmed = params.markup.trim();
  if (trimmed.startsWith("<view")) {
    return trimmed;
  }

  const attrs = [
    `id="${escapeAttribute(params.viewId)}"`,
    `type="${escapeAttribute(params.viewType?.trim() || "View")}"`,
    `name="${escapeAttribute(params.viewName?.trim() || params.viewType?.trim() || params.viewId)}"`,
    `app_id="${escapeAttribute(params.appId)}"`,
    `app_name="${escapeAttribute(params.appName?.trim() || params.appId)}"`,
  ];

  return `<view ${attrs.join(" ")}>\n${trimmed}\n</view>`;
}

function getMessageTimestamp(message: AgentMessage): number | null {
  const timestamp = (message as { timestamp?: unknown }).timestamp;
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : null;
}

function getInjectedMessageMeta(message: AgentMessage): AotuiInjectedMessageMeta | null {
  const metadata = (message as { metadata?: Record<string, unknown> }).metadata?.[
    AOTUI_METADATA_KEY
  ];
  if (typeof metadata !== "object" || metadata === null) {
    return null;
  }
  if (!(metadata as AotuiInjectedMessageMeta).aotui) {
    return null;
  }
  return metadata as AotuiInjectedMessageMeta;
}

function getInjectedMessageContent(message: AgentMessage): string {
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : JSON.stringify(content ?? null);
}

function buildInjectedReuseKey(message: AgentMessage): string | null {
  const meta = getInjectedMessageMeta(message);
  if (!meta) {
    return null;
  }
  return `${meta.kind}:${meta.viewId ?? ""}:${getInjectedMessageContent(message)}`;
}

function isSystemInstructionMessage(message: AgentMessage): boolean {
  return getInjectedMessageMeta(message)?.kind === "system_instruction";
}

function preserveStableInjectedTimestamps(
  previousMessages: AgentMessage[],
  injectedMessages: AgentMessage[],
): AgentMessage[] {
  const previousTimestampByKey = new Map<string, number>();
  for (const message of previousMessages) {
    const key = buildInjectedReuseKey(message);
    const timestamp = getMessageTimestamp(message);
    if (!key || timestamp === null) {
      continue;
    }
    previousTimestampByKey.set(key, timestamp);
  }

  return injectedMessages.map((message) => {
    const key = buildInjectedReuseKey(message);
    if (!key) {
      return message;
    }
    const preservedTimestamp = previousTimestampByKey.get(key);
    if (preservedTimestamp === undefined) {
      return message;
    }
    return {
      ...message,
      timestamp: preservedTimestamp,
    } as AgentMessage;
  });
}

function isToolResultMessage(message: AgentMessage | undefined): boolean {
  return (message as { role?: unknown } | undefined)?.role === "toolResult";
}

function isAssistantToolCallMessage(message: AgentMessage | undefined): boolean {
  if ((message as { role?: unknown } | undefined)?.role !== "assistant") {
    return false;
  }
  const content = (message as { content?: unknown }).content;
  return (
    Array.isArray(content) &&
    content.some(
      (block) =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "toolUse",
    )
  );
}

function findDynamicInsertIndex(messages: AgentMessage[], timestamp: number): number {
  let insertAt = messages.findIndex((message) => {
    const currentTimestamp = getMessageTimestamp(message);
    return currentTimestamp !== null && currentTimestamp > timestamp;
  });

  if (insertAt < 0) {
    insertAt = messages.length;
  }

  if (
    insertAt > 0 &&
    insertAt < messages.length &&
    isAssistantToolCallMessage(messages[insertAt - 1]) &&
    isToolResultMessage(messages[insertAt])
  ) {
    while (insertAt < messages.length && isToolResultMessage(messages[insertAt])) {
      insertAt += 1;
    }
  }

  return insertAt;
}

function insertDynamicMessages(
  transcript: AgentMessage[],
  dynamicMessages: AgentMessage[],
  insertAt: number,
): AgentMessage[] {
  if (dynamicMessages.length === 0) {
    return transcript;
  }

  const before = transcript.slice(0, insertAt);
  const tail = transcript.slice(insertAt);
  const sortedDynamicMessages = dynamicMessages
    .map((message, index) => ({ message, index }))
    .toSorted((a, b) => {
      const aTimestamp = getMessageTimestamp(a.message) ?? Number.MAX_SAFE_INTEGER;
      const bTimestamp = getMessageTimestamp(b.message) ?? Number.MAX_SAFE_INTEGER;
      if (aTimestamp !== bTimestamp) {
        return aTimestamp - bTimestamp;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.message);
  const result = [...before];
  let timeline = [...tail];
  for (const injected of sortedDynamicMessages) {
    const timestamp = getMessageTimestamp(injected);
    if (timestamp === null) {
      result.push(injected);
      continue;
    }
    const nextIndex = findDynamicInsertIndex(timeline, timestamp);
    result.push(...timeline.slice(0, nextIndex), injected);
    timeline = timeline.slice(nextIndex);
  }

  return [...result, ...timeline];
}

function projectStructuredMessages(snapshot: CachedSnapshot, meta: DesktopRecord): AgentMessage[] {
  const structured = snapshot.structured;
  if (!structured) {
    return [];
  }

  const messages: AgentMessage[] = [];
  messages.push(
    createInjectedMessage({
      role: "user",
      content: OPENCLAW_AOTUI_SYSTEM_INSTRUCTION,
      meta,
      snapshotId: snapshot.id,
      kind: "system_instruction",
      timestamp: structured.desktopTimestamp ?? snapshot.createdAt,
    }),
  );

  const dynamicEntries: DynamicObservationEntry[] = [];
  const desktopState = structured.desktopState?.trim();
  if (desktopState) {
    messages.push(
      createInjectedMessage({
        role: "user",
        content: wrapDesktopState(normalizeDesktopInstructionContent(desktopState)),
        meta,
        snapshotId: snapshot.id,
        kind: "desktop_state",
        timestamp: structured.desktopTimestamp ?? snapshot.createdAt,
      }),
    );
  }

  if (Array.isArray(structured.viewStates) && structured.viewStates.length > 0) {
    for (const view of structured.viewStates) {
      dynamicEntries.push({
        id: view.viewId,
        kind: "view_state",
        markup: wrapViewMarkup({
          appId: view.appId,
          appName: view.appName,
          viewId: view.viewId,
          viewType: view.viewType,
          viewName: view.viewName,
          markup: view.markup,
        }),
        timestamp: view.timestamp ?? snapshot.createdAt,
      });
    }
  } else {
    for (const fragment of structured.appStates) {
      dynamicEntries.push({
        id: fragment.appId,
        kind: "app_state",
        markup: wrapAppMarkup({
          appId: fragment.appId,
          appName: fragment.appName,
          markup: fragment.markup.trim(),
        }),
        timestamp: fragment.timestamp ?? snapshot.createdAt,
      });
    }
  }

  const sortedEntries = dynamicEntries.toSorted((a, b) => {
    const aTime = a.timestamp ?? Number.MAX_SAFE_INTEGER;
    const bTime = b.timestamp ?? Number.MAX_SAFE_INTEGER;
    if (aTime !== bTime) {
      return aTime - bTime;
    }
    return a.id.localeCompare(b.id);
  });
  for (const entry of sortedEntries) {
    const markup = entry.markup.trim();
    if (!markup) {
      continue;
    }
    messages.push(
      createInjectedMessage({
        role: "user",
        content: markup,
        meta,
        snapshotId: snapshot.id,
        kind: entry.kind,
        timestamp: entry.timestamp ?? snapshot.createdAt,
        ...(entry.kind === "view_state" ? { viewId: entry.id } : {}),
      }),
    );
  }

  return messages;
}

export function isAotuiInjectedMessage(message: AgentMessage): boolean {
  const metadata = (message as { metadata?: Record<string, unknown> }).metadata?.[
    AOTUI_METADATA_KEY
  ];
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    (metadata as AotuiInjectedMessageMeta).aotui
  );
}

export function stripAotuiInjectedMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter((message) => !isAotuiInjectedMessage(message));
}

export function replaceAotuiInjectedMessages(
  messages: AgentMessage[],
  injected: AgentMessage[],
): AgentMessage[] {
  const stabilizedInjected = preserveStableInjectedTimestamps(messages, injected);
  const stripped = stripAotuiInjectedMessages(messages);
  let preambleEnd = 0;
  while (preambleEnd < stripped.length) {
    const role = (stripped[preambleEnd] as { role?: unknown }).role;
    if (role !== "system") {
      break;
    }
    preambleEnd += 1;
  }

  const systemMessages = stabilizedInjected.filter(
    (message) =>
      (message as { role?: unknown }).role === "system" && !isSystemInstructionMessage(message),
  );
  const dynamicMessages = stabilizedInjected.filter(
    (message) =>
      (message as { role?: unknown }).role !== "system" && !isSystemInstructionMessage(message),
  );
  const preambleMessages = stabilizedInjected.filter((message) =>
    isSystemInstructionMessage(message),
  );

  const withSystem = [
    ...stripped.slice(0, preambleEnd),
    ...systemMessages,
    ...stripped.slice(preambleEnd),
  ];

  const preambleAnchor = preambleEnd + systemMessages.length;
  const withPreamble = [
    ...withSystem.slice(0, preambleAnchor),
    ...preambleMessages,
    ...withSystem.slice(preambleAnchor),
  ];

  const dynamicAnchor = preambleAnchor + preambleMessages.length;
  return insertDynamicMessages(withPreamble, dynamicMessages, dynamicAnchor);
}

function isRuntimeToolDefinition(entry: unknown): entry is RuntimeToolDefinitionLike {
  return typeof entry === "object" && entry !== null;
}

function toDesktopToolName(runtimeToolName: string): string {
  if (runtimeToolName.startsWith(RUNTIME_SYSTEM_TOOL_PREFIX)) {
    return `${OPENCLAW_DESKTOP_TOOL_PREFIX}${runtimeToolName.slice(
      RUNTIME_SYSTEM_TOOL_PREFIX.length,
    )}`;
  }
  return `${OPENCLAW_DESKTOP_TOOL_PREFIX}${runtimeToolName}`;
}

function toSystemOperationName(runtimeToolName: string): string {
  if (runtimeToolName.startsWith(RUNTIME_SYSTEM_TOOL_PREFIX)) {
    return runtimeToolName.slice(RUNTIME_SYSTEM_TOOL_PREFIX.length);
  }
  return runtimeToolName;
}

export class OpenClawSnapshotProjector implements AotuiSnapshotProjector {
  constructor(private readonly kernel?: Pick<IKernel, "getSystemToolDefinitions">) {}

  projectMessages(snapshot: CachedSnapshot, meta: DesktopRecord): AgentMessage[] {
    if (snapshot.structured) {
      return projectStructuredMessages(snapshot, meta);
    }

    const messages: AgentMessage[] = [
      createInjectedMessage({
        role: "user",
        content: OPENCLAW_AOTUI_SYSTEM_INSTRUCTION,
        meta,
        snapshotId: snapshot.id,
        kind: "system_instruction",
        timestamp: snapshot.createdAt,
      }),
    ];

    if (!snapshot.markup) {
      return messages;
    }

    messages.push(
      createInjectedMessage({
        role: "user",
        content: wrapDesktopState(normalizeDesktopInstructionContent(snapshot.markup)),
        meta,
        snapshotId: snapshot.id,
        kind: "desktop_state",
        timestamp: snapshot.createdAt,
      }),
    );

    return messages;
  }

  projectToolBindings(snapshot: CachedSnapshot, _meta: DesktopRecord): AotuiToolBinding[] {
    const bindings: AotuiToolBinding[] = [];
    const indexMap = snapshot.indexMap as IndexMap | undefined;

    for (const [key, value] of Object.entries(indexMap ?? {})) {
      if (isOperationEntry(value)) {
        bindings.push({
          toolName: value.operation.id,
          description: value.operation.displayName || value.operation.id,
          parameters: convertParamsToSchema(value.operation.params),
          operation: createViewOperation({
            appId: value.appId,
            operationName: value.operation.id,
          }),
        });
        continue;
      }

      if (key.startsWith("tool:") && isTypeToolEntry(value)) {
        const toolName = key.slice("tool:".length);
        const appId = value.appId || "system";
        const operationName = value.toolName || toolName;
        bindings.push({
          toolName,
          description: value.description || toolName,
          parameters: convertParamsToSchema(value.params),
          operation: createViewOperation({
            appId,
            viewId: value.viewType,
            operationName,
          }),
        });
      }
    }

    const systemTools = this.kernel?.getSystemToolDefinitions?.() ?? [];
    for (const tool of systemTools) {
      if (!isRuntimeToolDefinition(tool)) {
        continue;
      }
      const fn = tool.function;
      if (!fn?.name) {
        continue;
      }

      const toolName = toDesktopToolName(fn.name);
      if (bindings.some((binding) => binding.toolName === toolName)) {
        continue;
      }

      bindings.push({
        toolName,
        description: fn.description || toolName,
        parameters: fn.parameters || {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        },
        operation: createViewOperation({
          appId: "system",
          operationName: toSystemOperationName(fn.name),
        }),
      });
    }

    return bindings;
  }
}

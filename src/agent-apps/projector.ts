import type { CachedSnapshot, IndexMap, Operation } from "@aotui/runtime";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
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

const AOTUI_METADATA_KEY = "aotui";

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

function projectStructuredMessages(snapshot: CachedSnapshot, meta: DesktopRecord): AgentMessage[] {
  const structured = snapshot.structured;
  if (!structured) {
    return [];
  }

  const messages: AgentMessage[] = [];
  if (structured.systemInstruction) {
    messages.push(
      createInjectedMessage({
        role: "system",
        content: structured.systemInstruction,
        meta,
        snapshotId: snapshot.id,
        kind: "system_instruction",
        timestamp: snapshot.createdAt,
      }),
    );
  }

  if (structured.desktopState) {
    messages.push(
      createInjectedMessage({
        role: "system",
        content: structured.desktopState,
        meta,
        snapshotId: snapshot.id,
        kind: "desktop_state",
        timestamp: snapshot.createdAt,
      }),
    );
  }

  if (Array.isArray(structured.viewStates) && structured.viewStates.length > 0) {
    for (const view of structured.viewStates) {
      messages.push(
        createInjectedMessage({
          role: view.role ?? "user",
          content: view.markup,
          meta,
          snapshotId: snapshot.id,
          kind: "view_state",
          timestamp: view.timestamp ?? snapshot.createdAt,
          viewId: view.viewId,
        }),
      );
    }
    return messages;
  }

  for (const fragment of structured.appStates) {
    messages.push(
      createInjectedMessage({
        role: fragment.role ?? "user",
        content: fragment.markup,
        meta,
        snapshotId: snapshot.id,
        kind: "view_state",
        timestamp: fragment.timestamp ?? snapshot.createdAt,
        viewId: fragment.appId,
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
  return [...stripAotuiInjectedMessages(messages), ...injected];
}

export class OpenClawSnapshotProjector implements AotuiSnapshotProjector {
  projectMessages(snapshot: CachedSnapshot, meta: DesktopRecord): AgentMessage[] {
    if (snapshot.structured) {
      return projectStructuredMessages(snapshot, meta);
    }

    if (!snapshot.markup) {
      return [];
    }

    return [
      createInjectedMessage({
        role: "system",
        content: snapshot.markup,
        meta,
        snapshotId: snapshot.id,
        kind: "desktop_state",
        timestamp: snapshot.createdAt,
      }),
    ];
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

    return bindings;
  }
}

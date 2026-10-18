import { randomUUID } from "node:crypto";
import { ContentBlockSchema, type ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { ImageContent } from "../llm/types.js";
import { notifyListeners } from "../shared/listeners.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import {
  escapeInternalRuntimeContextDelimiters,
  type RuntimeContextFragment,
} from "./internal-runtime-context.js";

const MCP_APP_MODEL_CONTEXT_MAX_BYTES = 6 * 1024 * 1024;

export type McpAppModelContextState = {
  updateId: string;
  content?: ContentBlock[];
  structuredContent?: Record<string, unknown>;
} | null;

type Snapshot = NonNullable<McpAppModelContextState> & { leased?: boolean };
type UpdateModelContextParams = { content?: unknown; structuredContent?: unknown };
// The runtime and exact view lease own the lifetime; neither transcript nor config stores App data.
const contexts = new WeakMap<SessionMcpRuntime, Map<object, Snapshot>>();
const listeners = new WeakMap<object, Set<(state: McpAppModelContextState) => void>>();

function notify(view: object, state: McpAppModelContextState) {
  notifyListeners(listeners.get(view) ?? [], state);
}

export function subscribeMcpAppModelContext(
  view: object,
  listener: (state: McpAppModelContextState) => void,
): () => void {
  const subscribed = listeners.get(view) ?? new Set();
  subscribed.add(listener);
  listeners.set(view, subscribed);
  return () => {
    subscribed.delete(listener);
    if (!subscribed.size && listeners.get(view) === subscribed) {
      listeners.delete(view);
    }
  };
}

export function getMcpAppModelContext(
  runtime: SessionMcpRuntime,
  view: object,
): McpAppModelContextState {
  const snapshot = contexts.get(runtime)?.get(view);
  if (!snapshot || runtime.mcpAppModelContextRevoked) {
    return null;
  }
  const { leased: _leased, ...state } = snapshot;
  return structuredClone(state);
}

export function revokeMcpAppModelContext(runtime: SessionMcpRuntime): void {
  runtime.mcpAppModelContextRevoked = true;
  const views = contexts.get(runtime);
  contexts.delete(runtime);
  for (const view of views?.keys() ?? []) {
    notify(view, null);
  }
}

export function allowMcpAppModelContext(runtime: SessionMcpRuntime): void {
  runtime.mcpAppModelContextRevoked = undefined;
}

export function clearMcpAppModelContextForView(runtime: SessionMcpRuntime, view: object): void {
  if (contexts.get(runtime)?.delete(view)) {
    notify(view, null);
  }
}

export function updateMcpAppModelContext(
  runtime: SessionMcpRuntime,
  view: object,
  params: UpdateModelContextParams,
): { _meta: { "openai/modelContext": { updateId: string } } } {
  if (runtime.mcpAppModelContextRevoked === true) {
    throw new Error("MCP App model context is unavailable for this session");
  }
  if (params.content !== undefined && !Array.isArray(params.content)) {
    throw new Error("MCP App model context content must be an array");
  }
  const content = params.content?.map((value: unknown) => {
    const block = ContentBlockSchema.parse(value);
    if (block.type === "audio") {
      throw new Error("MCP App audio context is unsupported");
    }
    return block;
  });
  const structuredContent = asOptionalRecord(params.structuredContent);
  if (params.structuredContent !== undefined && !structuredContent) {
    throw new Error("MCP App structured context must be an object");
  }
  const next = {
    ...(content?.length ? { content } : {}),
    ...(structuredContent !== undefined ? { structuredContent } : {}),
  };
  const serialized = JSON.stringify(next);
  const views = contexts.get(runtime) ?? new Map<object, Snapshot>();
  const previous = views.get(view);
  const { updateId: _updateId, leased: _leased, ...previousData } = previous ?? {};
  const updateId =
    previous && JSON.stringify(previousData) === serialized ? previous.updateId : randomUUID();
  const totalBytes =
    Buffer.byteLength(serialized, "utf8") +
    [...views.entries()]
      .filter(([owner]) => owner !== view)
      .reduce((total, [, state]) => total + Buffer.byteLength(JSON.stringify(state), "utf8"), 0);
  if (totalBytes > MCP_APP_MODEL_CONTEXT_MAX_BYTES) {
    throw new Error(`MCP App model context exceeds ${MCP_APP_MODEL_CONTEXT_MAX_BYTES} bytes`);
  }
  if (!next.content && next.structuredContent === undefined) {
    views.delete(view);
  } else if (previous?.updateId !== updateId) {
    views.set(view, { ...structuredClone(next), updateId });
  }
  contexts.set(runtime, views);
  notify(view, getMcpAppModelContext(runtime, view));
  return { _meta: { "openai/modelContext": { updateId } } };
}

/** User attachment removal is optimistic only against the exact rendered revision. */
export function removeMcpAppModelContextItem(
  runtime: SessionMcpRuntime,
  view: object,
  updateId: string,
  index?: number,
): McpAppModelContextState {
  const state = getMcpAppModelContext(runtime, view);
  if (!state) {
    return null;
  }
  if (state.updateId !== updateId) {
    throw new Error("MCP App context changed; refresh before removing it");
  }
  if (index === undefined) {
    updateMcpAppModelContext(runtime, view, {});
  } else {
    if (!Number.isInteger(index) || index < 0 || index >= (state.content?.length ?? 0)) {
      throw new Error("MCP App context item does not exist");
    }
    updateMcpAppModelContext(runtime, view, {
      content: state.content?.filter((_, position) => position !== index),
      structuredContent: state.structuredContent,
    });
  }
  return getMcpAppModelContext(runtime, view);
}

/** Keep presentation metadata in the host, never in the next-turn model input. */
function modelContent(block: ContentBlock): ContentBlock {
  const { _meta: _presentation, ...content } = block;
  if (content.type === "resource") {
    const { _meta: _resourcePresentation, ...resource } = content.resource;
    return { ...content, resource };
  }
  return content;
}

/** Native user input keeps image bytes out of text while preserving resource and structured data. */
export function projectMcpAppModelContextInput(
  appContexts: Array<{ content?: ContentBlock[]; structuredContent?: Record<string, unknown> }>,
  imageOffset = 0,
) {
  const images: ImageContent[] = [];
  const content = appContexts.map((context) => ({
    ...(context.content
      ? {
          content: context.content.map((block) => {
            if (block.type === "image") {
              images.push({ type: "image", data: block.data, mimeType: block.mimeType });
              return {
                type: "image",
                mimeType: block.mimeType,
                imageIndex: imageOffset + images.length - 1,
              };
            }
            if (
              block.type === "resource" &&
              "blob" in block.resource &&
              block.resource.mimeType?.startsWith("image/")
            ) {
              images.push({
                type: "image",
                data: block.resource.blob,
                mimeType: block.resource.mimeType,
              });
              return {
                type: "resource",
                resource: {
                  uri: block.resource.uri,
                  mimeType: block.resource.mimeType,
                  imageIndex: imageOffset + images.length - 1,
                },
              };
            }
            return block;
          }),
        }
      : {}),
    ...(context.structuredContent !== undefined
      ? { structuredContent: context.structuredContent }
      : {}),
  }));
  const text = "MCP App context snapshots:\n" + JSON.stringify(content);
  return {
    images,
    context: { kind: "conversation-data", text } satisfies RuntimeContextFragment,
    legacyText: escapeInternalRuntimeContextDelimiters(text),
  };
}

export function leaseMcpAppModelContextForTurn(params: {
  runtime: SessionMcpRuntime;
  views?: ReadonlySet<object>;
}) {
  if (params.runtime.mcpAppModelContextRevoked === true) {
    return undefined;
  }
  const views = contexts.get(params.runtime);
  const snapshots = [...(views?.entries() ?? [])].filter(
    ([view, snapshot]) => !snapshot.leased && (!params.views || params.views.has(view)),
  );
  if (!snapshots.length) {
    return undefined;
  }
  for (const [, snapshot] of snapshots) {
    snapshot.leased = true;
  }
  const modelContext = snapshots.map(([, snapshot]) => ({
    ...(snapshot.content ? { content: snapshot.content.map(modelContent) } : {}),
    ...(snapshot.structuredContent !== undefined
      ? { structuredContent: snapshot.structuredContent }
      : {}),
  }));
  const input = projectMcpAppModelContextInput(modelContext);
  let committed = false;
  return {
    // Harness adapters consume these as conversation input, including native image blocks.
    modelContext,
    ...input,
    assertCurrent: () => {
      params.runtime.assertOwnerCurrent?.();
      if (
        params.runtime.mcpAppModelContextRevoked ||
        snapshots.some(([view, snapshot]) => views?.get(view) !== snapshot)
      ) {
        throw new Error("MCP App context authority changed before input custody");
      }
    },
    commit: () => {
      committed = true;
      for (const [view, snapshot] of snapshots) {
        if (views?.get(view) === snapshot) {
          views.delete(view);
          notify(view, null);
        }
      }
    },
    rollback: () => {
      if (!committed) {
        for (const [, snapshot] of snapshots) {
          snapshot.leased = undefined;
        }
      }
    },
  };
}

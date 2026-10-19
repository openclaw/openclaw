import type {
  CallToolRequestParams,
  CallToolResult,
  ClientCapabilities,
  CompleteRequestParams,
  CompleteResult,
  CreateMessageRequestParams,
  CreateMessageResult,
  ElicitRequestParams,
  ElicitResult,
  GetPromptRequestParams,
  GetPromptResult,
  InputRequiredResult,
  InputResponses,
  ListPromptsResult,
  ListResourceTemplatesResult,
  ListResourcesResult,
  ListRootsResult,
  ListToolsResult,
  PaginatedRequestParams,
  ReadResourceRequestParams,
  ReadResourceResult,
  RequestOptions,
  ServerNotification,
} from "@modelcontextprotocol/client";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import type { McpElicitationHandler } from "./mcp-client-elicitation.js";

type NativeMcpCallbackOptions = { signal: AbortSignal };
export type NativeMcpClientContext = {
  /** Identity of the native client's capability lifecycle, shared by identical snapshots. */
  readonly capabilityContext: object;
  readonly capabilities: ClientCapabilities;
  /** Immutable owner snapshot; changed roots require acquiring a new view. */
  readonly roots: ListRootsResult;
  assertCurrent: () => void;
  elicit?: (
    params: ElicitRequestParams,
    options: NativeMcpCallbackOptions,
  ) => Promise<ElicitResult>;
  elicitCustom?: (
    params: Record<string, unknown>,
    options: NativeMcpCallbackOptions,
  ) => ReturnType<McpElicitationHandler>;
  createMessage?: (
    params: CreateMessageRequestParams,
    options: NativeMcpCallbackOptions,
  ) => Promise<CreateMessageResult>;
};

export type NativeMcpRequestOptions = NativeMcpCallbackOptions & {
  assertCurrent: () => void;
  onprogress?: RequestOptions["onprogress"];
};

/** The continuation closes over the originating view and request, never a client-supplied id. */
export type NativeMcpResponse<T> =
  | { kind: "complete"; result: T }
  | {
      kind: "input-required";
      result: InputRequiredResult;
      resume: (
        responses: InputResponses,
        options: NativeMcpRequestOptions,
      ) => Promise<NativeMcpResponse<T>>;
    };

export type NativeMcpServerEvent =
  | { kind: "notification"; notification: ServerNotification }
  | { kind: "invalidated" }
  | { kind: "closed" };

type Page<P, R> = (params: P, options: NativeMcpRequestOptions) => Promise<R>;
type Flow<P, R> = Page<P, NativeMcpResponse<R>>;

/** Internal projection preparation only; intentionally absent from plugin SDK barrels. */
export type NativeMcpServerView = {
  runtime: SessionMcpRuntime;
  getServerInfo: import("@modelcontextprotocol/client").Client["getServerVersion"];
  getCapabilities: import("@modelcontextprotocol/client").Client["getServerCapabilities"];
  getInstructions: import("@modelcontextprotocol/client").Client["getInstructions"];
  getProtocolEra: import("@modelcontextprotocol/client").Client["getProtocolEra"];
  getProtocolVersion: import("@modelcontextprotocol/client").Client["getNegotiatedProtocolVersion"];
  listTools: Page<PaginatedRequestParams | undefined, ListToolsResult>;
  listResources: Page<PaginatedRequestParams | undefined, ListResourcesResult>;
  listResourceTemplates: Page<PaginatedRequestParams | undefined, ListResourceTemplatesResult>;
  listPrompts: Page<PaginatedRequestParams | undefined, ListPromptsResult>;
  callTool: Flow<CallToolRequestParams, CallToolResult>;
  readResource: Flow<ReadResourceRequestParams, ReadResourceResult>;
  getPrompt: Flow<GetPromptRequestParams, GetPromptResult>;
  complete: Page<CompleteRequestParams, CompleteResult>;
  /** Announces this snapshot; a different roots snapshot belongs to a new acquisition. */
  rootsChanged: (options: NativeMcpRequestOptions) => Promise<void>;
  subscribe: (listener: (event: NativeMcpServerEvent) => void) => () => void;
  release: () => Promise<void>;
};

export type NativeMcpRuntimeBinding = {
  hasServer: (serverName: string) => boolean;
  acquire: (serverName: string, context: NativeMcpClientContext) => Promise<NativeMcpServerView>;
};

// A binding exposes operations; the session runtime remains the only transport/lifecycle owner.
export const nativeMcpRuntimeBindings = resolveGlobalSingleton(
  Symbol.for("openclaw.nativeMcpRuntimeBindings"),
  () => new WeakMap<SessionMcpRuntime, NativeMcpRuntimeBinding>(),
);

export async function acquireNativeMcpServer(
  runtime: SessionMcpRuntime,
  serverName: string,
  context: NativeMcpClientContext,
): Promise<NativeMcpServerView> {
  context.assertCurrent();
  const binding = nativeMcpRuntimeBindings.get(runtime);
  if (!binding) {
    throw new Error("MCP runtime has no projection binding");
  }
  const view = await binding.acquire(serverName, context);
  try {
    context.assertCurrent();
    return view;
  } catch (error) {
    await view.release();
    throw error;
  }
}

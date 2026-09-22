import type { OpenClawPluginNodeHostCommand } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexAppServerBindingStore } from "./app-server/session-binding.js";
import type { CodexCatalogHome } from "./session-catalog-homes.js";
import {
  CatalogParamsError,
  CODEX_APP_SERVER_THREADS_CAPABILITY,
  CODEX_APP_SERVER_THREADS_LIST_COMMAND,
  CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
  CODEX_CATALOG_TRANSCRIPT_READ_COMMAND,
  CODEX_LOCAL_SESSION_HOST_ID,
  DEFAULT_TRANSCRIPT_PAGE_LIMIT,
  MAX_CURSOR_LENGTH,
  MAX_SESSION_ID_LENGTH,
  MAX_TRANSCRIPT_PAGE_LIMIT,
  NODE_INVOKE_TIMEOUT_MS,
  parseJsonParams,
  parseTranscriptPage,
  readBoundedOptionalString,
  readControlCursor,
  readPageParams,
  requireOnlyKeys,
  unwrapNodeInvokePayload,
} from "./session-catalog-parsing.js";
import {
  createCodexTerminalNodeHostCommand,
  createCodexTerminalStartNodeHostCommand,
} from "./session-catalog-terminal.js";
import {
  parseCodexCatalogTranscriptPage,
  readCodexCatalogTranscriptPage,
  readLegacyCodexTranscriptPage,
} from "./session-catalog-transcript.js";
import type {
  CodexSessionCatalogControl,
  CodexSessionCatalogControlFactory,
  CodexSessionTranscriptPage,
} from "./session-catalog-types.js";
import { listVisiblePage } from "./session-catalog-visible-page.js";

/** Builds the node-local read-only Codex app-server catalog command. */
export function createCodexSessionCatalogNodeHostCommands(
  controlFactory: CodexSessionCatalogControlFactory,
  bindingStore?: CodexAppServerBindingStore,
): OpenClawPluginNodeHostCommand[] {
  // Native sources ignore the Gateway route; explicit preexisting sources retain their selector.
  const bindRequest = async (paramsJSON?: string | null) => {
    const parsed = parseJsonParams(paramsJSON);
    if (!isRecord(parsed)) {
      throw new CatalogParamsError("Codex session catalog parameters must be an object");
    }
    const agentId = readBoundedOptionalString(parsed, "agentId", MAX_SESSION_ID_LENGTH);
    const request = { ...parsed };
    delete request.agentId;
    return {
      ...(await controlFactory.forNode(agentId)),
      params: request,
      paramsJSON: JSON.stringify(request),
    };
  };
  const commands: OpenClawPluginNodeHostCommand[] = [
    {
      command: CODEX_APP_SERVER_THREADS_LIST_COMMAND,
      cap: CODEX_APP_SERVER_THREADS_CAPABILITY,
      dangerous: false,
      handle: async (paramsJSON) => {
        const request = await bindRequest(paramsJSON);
        const pageParams = readPageParams(request.params);
        try {
          const managedThreads = await bindingStore?.managedThreads?.snapshot();
          const sourceHomeId = request.sourceHomeId;
          const managedThreadIds = sourceHomeId ? managedThreads?.get(sourceHomeId) : undefined;
          const page = await listVisiblePage({
            control: request.control,
            cursor: pageParams.cursor,
            cwd: pageParams.cwd,
            excludedThreadIds: managedThreadIds,
            limit: pageParams.limit,
            ...(sourceHomeId && bindingStore?.managedThreads
              ? {
                  onExcludedThread: async ({ threadId, rolloutPath }) => {
                    if (!managedThreadIds?.has(threadId)) {
                      await bindingStore.managedThreads?.mark({
                        sourceHomeId,
                        threadId,
                        ...(rolloutPath ? { rolloutPath } : {}),
                      });
                    }
                  },
                }
              : {}),
            searchTerm: pageParams.searchTerm,
          });
          return JSON.stringify(page);
        } catch {
          // App-server stderr and transport details stay on the node boundary.
          throw new Error("Codex app-server catalog is unavailable");
        }
      },
    },
    {
      command: CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND,
      cap: CODEX_APP_SERVER_THREADS_CAPABILITY,
      dangerous: false,
      handle: async (paramsJSON) => {
        const request = await bindRequest(paramsJSON);
        const action = readNodeTranscriptParams(request.params);
        try {
          await request.control.requireEligibleThread(action.threadId);
          const page = parseTranscriptPage(
            await request.control.listTurnPage({
              threadId: action.threadId,
              limit: action.limit,
              sortDirection: "desc",
              itemsView: "full",
              ...(action.cursor ? { cursor: action.cursor } : {}),
            }),
          );
          return JSON.stringify(page);
        } catch (error) {
          if (error instanceof CatalogParamsError) {
            throw error;
          }
          throw new Error("Codex app-server transcript is unavailable", { cause: error });
        }
      },
    },
    {
      command: CODEX_CATALOG_TRANSCRIPT_READ_COMMAND,
      cap: CODEX_APP_SERVER_THREADS_CAPABILITY,
      dangerous: false,
      handle: async (paramsJSON) => {
        const request = await bindRequest(paramsJSON);
        const action = readNodeTranscriptParams(request.params);
        try {
          return JSON.stringify(await readCodexCatalogTranscriptPage(request.control, action));
        } catch (error) {
          if (error instanceof CatalogParamsError) {
            throw error;
          }
          throw new Error("Codex app-server transcript is unavailable", { cause: error });
        }
      },
    },
    createCodexTerminalNodeHostCommand(bindRequest),
    createCodexTerminalStartNodeHostCommand(),
  ];
  // MacNodeHostWorker sets app ownership at launch. Its native catalog may use a
  // different home, so the embedded worker must not advertise a replacement reader.
  return process.env.OPENCLAW_NODE_EXEC_HOST?.trim().toLowerCase() === "app"
    ? commands.filter(({ command }) => command !== CODEX_CATALOG_TRANSCRIPT_READ_COMMAND)
    : commands;
}

type CodexNodeSessionTranscriptParams = {
  threadId: string;
  cursor?: string;
  limit: number;
};

function readNodeTranscriptParams(value: unknown): CodexNodeSessionTranscriptParams {
  if (!isRecord(value)) {
    throw new CatalogParamsError("Codex session read parameters must be an object");
  }
  requireOnlyKeys(value, new Set(["threadId", "cursor", "limit"]));
  const threadId = readBoundedOptionalString(value, "threadId", MAX_SESSION_ID_LENGTH);
  if (!threadId) {
    throw new CatalogParamsError("threadId is required");
  }
  const cursor = readBoundedOptionalString(value, "cursor", MAX_CURSOR_LENGTH);
  const limit = readBoundedLimit(
    value.limit,
    "limit",
    DEFAULT_TRANSCRIPT_PAGE_LIMIT,
    MAX_TRANSCRIPT_PAGE_LIMIT,
  );
  return { threadId, limit, ...(cursor ? { cursor } : {}) };
}

function readBoundedLimit(value: unknown, key: string, fallback: number, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw new CatalogParamsError(`${key} must be an integer from 1 to ${max}`);
  }
  return value as number;
}

/** Reads the persisted transcript for a Gateway-local or paired-node Codex session. */
export async function readCodexSessionTranscript(params: {
  agentId: string;
  runtime: PluginRuntime;
  control: CodexSessionCatalogControl;
  hostId: string;
  threadId: string;
  cursor?: string;
  limit: number;
  source?: CodexCatalogHome;
}): Promise<CodexSessionTranscriptPage> {
  const cursor = readControlCursor(params.cursor, "transcript request");
  // The read RPC leaves `limit` open-ended; every provider owns its own ceiling.
  const limit = readBoundedLimit(
    params.limit,
    "limit",
    DEFAULT_TRANSCRIPT_PAGE_LIMIT,
    MAX_TRANSCRIPT_PAGE_LIMIT,
  );
  if (params.source || params.hostId === CODEX_LOCAL_SESSION_HOST_ID) {
    const page = await readCodexCatalogTranscriptPage(params.control, {
      threadId: params.threadId,
      limit,
      cursor,
    });
    return {
      hostId: params.hostId,
      label: params.source?.label ?? "Local Codex",
      threadId: params.threadId,
      ...page,
    };
  }

  const nodeId = params.hostId.slice("node:".length);
  const node = (await params.runtime.nodes.list()).nodes.find(
    (candidate) =>
      candidate.nodeId === nodeId &&
      candidate.connected === true &&
      candidate.commands?.includes(CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND),
  );
  if (!node) {
    throw new CatalogParamsError("paired-node Codex session host is offline or unavailable");
  }
  const invoke = async (command: string, request: { cursor?: string; limit: number }) =>
    unwrapNodeInvokePayload(
      await params.runtime.nodes.invoke({
        nodeId,
        command,
        params: {
          agentId: params.agentId,
          threadId: params.threadId,
          ...request,
        },
        timeoutMs: NODE_INVOKE_TIMEOUT_MS,
        scopes: ["operator.write"],
      }),
    );
  // The shipped turns command is also consumed by native continuation. Older/native
  // nodes keep that contract; upgraded headless nodes bound before node serialization.
  const page = node.commands?.includes(CODEX_CATALOG_TRANSCRIPT_READ_COMMAND)
    ? parseCodexCatalogTranscriptPage(
        await invoke(CODEX_CATALOG_TRANSCRIPT_READ_COMMAND, { cursor, limit }),
      )
    : await readLegacyCodexTranscriptPage(
        async ({ cursor: turnCursor, limit: turnLimit }) =>
          parseTranscriptPage(
            await invoke(CODEX_APP_SERVER_THREAD_TURNS_LIST_COMMAND, {
              cursor: turnCursor,
              limit: turnLimit,
            }),
          ),
        { threadId: params.threadId, cursor, limit },
      );
  const { nodeLabel } = await import("./session-catalog-node-continue.js");
  return {
    hostId: params.hostId,
    label: nodeLabel(node),
    threadId: params.threadId,
    ...page,
  };
}

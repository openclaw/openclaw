/**
 * Owner-only access to native Codex threads stored in the user's Codex home.
 */
import path from "node:path";
import {
  jsonResult,
  readStringParam,
  type AnyAgentTool,
  type PluginRuntime,
} from "openclaw/plugin-sdk/core";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import { readCodexPluginConfig } from "./app-server/config.js";
import { CODEX_INTERACTIVE_THREAD_SOURCE_KINDS, isJsonObject } from "./app-server/protocol.js";
import {
  clearCodexAppServerBinding,
  readCodexAppServerBinding,
  writeCodexAppServerBinding,
} from "./app-server/session-binding.js";
import { codexControlRequest, type CodexControlRequestOptions } from "./command-rpc.js";

const ListParamsSchema = Type.Object(
  {
    action: Type.Literal("list"),
    archived: Type.Optional(Type.Boolean()),
    cursor: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    search: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const ReadParamsSchema = Type.Object(
  {
    action: Type.Literal("read"),
    thread_id: Type.String(),
    include_turns: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

const ForkParamsSchema = Type.Object(
  {
    action: Type.Literal("fork"),
    thread_id: Type.String(),
    attach: Type.Optional(
      Type.Boolean({
        default: true,
        description: "Attach the fork to this OpenClaw session for its next turn.",
      }),
    ),
  },
  { additionalProperties: false },
);

const RenameParamsSchema = Type.Object(
  {
    action: Type.Literal("rename"),
    thread_id: Type.String(),
    name: Type.String(),
  },
  { additionalProperties: false },
);

const ArchiveParamsSchema = Type.Object(
  {
    action: Type.Literal("archive"),
    thread_id: Type.String(),
    confirm: Type.Literal(true, {
      description: "Required acknowledgement that the thread is closed in other Codex clients.",
    }),
  },
  { additionalProperties: false },
);

const UnarchiveParamsSchema = Type.Object(
  {
    action: Type.Literal("unarchive"),
    thread_id: Type.String(),
  },
  { additionalProperties: false },
);

const CodexThreadsParamsSchema = Type.Union([
  ListParamsSchema,
  ReadParamsSchema,
  ForkParamsSchema,
  RenameParamsSchema,
  ArchiveParamsSchema,
  UnarchiveParamsSchema,
]);

type CodexThreadsToolOptions = {
  context: OpenClawPluginToolContext;
  runtime: PluginRuntime;
  getPluginConfig: () => unknown;
  request?: typeof codexControlRequest;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 100
    ? value
    : undefined;
}

function resolveSessionFile(
  context: OpenClawPluginToolContext,
  runtime: PluginRuntime,
): string | undefined {
  const sessionKey = context.sessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  const entry = runtime.agent.session.getSessionEntry({
    agentId: context.agentId,
    sessionKey,
    readConsistency: "latest",
  });
  const sessionId = context.sessionId?.trim() || entry?.sessionId?.trim();
  if (!sessionId) {
    return undefined;
  }
  const storePath = runtime.agent.session.resolveStorePath(undefined, {
    agentId: context.agentId,
  });
  return runtime.agent.session.resolveSessionFilePath(sessionId, entry, {
    agentId: context.agentId,
    sessionsDir: path.dirname(storePath),
  });
}

function readThreadId(params: Record<string, unknown>): string {
  return readStringParam(params, "thread_id", { required: true, label: "thread_id" });
}

function readThreadStatusType(value: unknown): string | undefined {
  if (!isJsonObject(value) || !isJsonObject(value.thread) || !isJsonObject(value.thread.status)) {
    return undefined;
  }
  return typeof value.thread.status.type === "string" ? value.thread.status.type : undefined;
}

/** Builds the native Codex thread tool only for owner runs in shared-user-home mode. */
export function createCodexThreadsTool(options: CodexThreadsToolOptions): AnyAgentTool | null {
  if (options.context.senderIsOwner !== true) {
    return null;
  }
  if (readCodexPluginConfig(options.getPluginConfig()).appServer?.homeScope !== "user") {
    return null;
  }
  const request = options.request ?? codexControlRequest;
  const requestOptions = (): CodexControlRequestOptions => ({
    agentDir: options.context.agentDir,
    config:
      options.context.getRuntimeConfig?.() ??
      options.context.runtimeConfig ??
      options.context.config,
    sessionId: options.context.sessionId,
    sessionKey: options.context.sessionKey,
  });
  const currentSessionFile = () => resolveSessionFile(options.context, options.runtime);
  const currentBinding = async (sessionFile: string | undefined) =>
    sessionFile
      ? await readCodexAppServerBinding(sessionFile, {
          agentDir: options.context.agentDir,
          config: requestOptions().config,
        })
      : undefined;

  return {
    name: "codex_threads",
    label: "Codex Threads",
    description:
      "List, read, fork, rename, archive, or restore native Codex threads. Fork to continue a thread safely across Codex clients; do not resume the same thread from two clients.",
    parameters: CodexThreadsParamsSchema,
    async execute(_toolCallId, rawParams) {
      const params = asRecord(rawParams);
      const action = readStringParam(params, "action", { required: true, label: "action" });
      const pluginConfig = options.getPluginConfig();

      if (action === "list") {
        const cursor = readStringParam(params, "cursor");
        const searchTerm = readStringParam(params, "search");
        const response = await request(
          pluginConfig,
          CODEX_CONTROL_METHODS.listThreads,
          {
            archived: readBoolean(params.archived),
            limit: readLimit(params.limit) ?? 20,
            modelProviders: [],
            sortKey: "recency_at",
            sortDirection: "desc",
            sourceKinds: [...CODEX_INTERACTIVE_THREAD_SOURCE_KINDS],
            ...(cursor ? { cursor } : {}),
            ...(searchTerm ? { searchTerm } : {}),
          },
          requestOptions(),
        );
        return jsonResult(response);
      }

      const threadId = readThreadId(params);
      if (action === "read") {
        const response = await request(
          pluginConfig,
          CODEX_CONTROL_METHODS.readThread,
          { threadId, includeTurns: readBoolean(params.include_turns) },
          requestOptions(),
        );
        return jsonResult(response);
      }
      if (action === "rename") {
        const name = readStringParam(params, "name", { required: true, label: "name" });
        await request(
          pluginConfig,
          CODEX_CONTROL_METHODS.renameThread,
          { threadId, name },
          requestOptions(),
        );
        return jsonResult({ action, threadId, name });
      }
      if (action === "unarchive") {
        const response = await request(
          pluginConfig,
          CODEX_CONTROL_METHODS.unarchiveThread,
          { threadId },
          requestOptions(),
        );
        return jsonResult(response);
      }

      const sessionFile = currentSessionFile();
      const binding = await currentBinding(sessionFile);
      if (action === "archive") {
        if (params.confirm !== true) {
          throw new Error("confirm=true is required to archive a native Codex thread");
        }
        if (binding?.threadId === threadId) {
          const current = await request(
            pluginConfig,
            CODEX_CONTROL_METHODS.readThread,
            { threadId, includeTurns: false },
            requestOptions(),
          );
          if (readThreadStatusType(current) === "active") {
            throw new Error("cannot archive the Codex thread active in this OpenClaw session");
          }
        }
        await request(
          pluginConfig,
          CODEX_CONTROL_METHODS.archiveThread,
          { threadId },
          requestOptions(),
        );
        if (sessionFile && binding?.threadId === threadId) {
          await clearCodexAppServerBinding(sessionFile);
        }
        return jsonResult({ action, threadId });
      }
      if (action !== "fork") {
        throw new Error(`unsupported codex_threads action: ${action}`);
      }

      const attach = readBoolean(params.attach, true);
      if (attach && !sessionFile) {
        throw new Error("cannot attach a Codex fork without an active OpenClaw session");
      }
      if (attach && binding?.threadId === threadId) {
        const current = await request(
          pluginConfig,
          CODEX_CONTROL_METHODS.readThread,
          { threadId, includeTurns: false },
          requestOptions(),
        );
        if (readThreadStatusType(current) === "active") {
          throw new Error("cannot replace the Codex thread active in this OpenClaw turn");
        }
      }
      const response = await request(
        pluginConfig,
        CODEX_CONTROL_METHODS.forkThread,
        { threadId },
        requestOptions(),
      );
      if (!isJsonObject(response) || !isJsonObject(response.thread)) {
        throw new Error("Codex app-server returned an invalid thread/fork response");
      }
      const forkThreadId =
        typeof response.thread.id === "string" && response.thread.id.trim()
          ? response.thread.id
          : undefined;
      if (!forkThreadId) {
        throw new Error("Codex app-server thread/fork response did not include a thread id");
      }
      if (attach && sessionFile) {
        await writeCodexAppServerBinding(sessionFile, {
          threadId: forkThreadId,
          cwd:
            typeof response.thread.cwd === "string"
              ? response.thread.cwd
              : (options.context.workspaceDir ?? ""),
          model: typeof response.model === "string" ? response.model : undefined,
          modelProvider:
            typeof response.modelProvider === "string" ? response.modelProvider : undefined,
        });
      }
      return jsonResult({
        action,
        sourceThreadId: threadId,
        thread: response.thread,
        attached: attach,
      });
    },
  };
}

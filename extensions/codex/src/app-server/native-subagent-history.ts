import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveCodexBindingAppServerConnection } from "./binding-connection.js";
import { itemToolArgs, itemTranscriptResultText } from "./event-projector-tool-items.js";
import {
  codexNativeSubagentHistoryConnectionFingerprint,
  readCodexNativeSubagentHistoryOwner,
} from "./native-subagent-history-owner.js";
import {
  CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX,
  CODEX_NATIVE_SUBAGENT_TASK_KIND,
} from "./native-subagent-task-ids.js";
import {
  buildCodexAppServerConnectionFingerprint,
  buildCodexAppServerRuntimeFingerprint,
} from "./plugin-app-cache-key.js";
import type { CodexAppServerRequestParams, CodexThread } from "./protocol.js";
import { sessionBindingIdentity } from "./session-binding-record.js";
import type { CodexAppServerBindingStore } from "./session-binding.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import { readCodexThreadHistoryPage } from "./thread-history-page.js";
import { projectCodexThreadHistoryItem } from "./transcript-history-projection.js";
import { readMirrorIdentity } from "./upstream-prompt-provenance.js";

type TaskHistoryParams = Parameters<NonNullable<AgentHarnessV2["taskHistory"]>["read"]>[0];
const MAX_SUBAGENT_ANCESTRY_READS = 32;
const taskHistoryToolItems = { itemToolArgs, itemTranscriptResultText };

function parentThreadId(thread: CodexThread): string | undefined {
  const source = thread.source;
  const spawn =
    source &&
    typeof source === "object" &&
    "subAgent" in source &&
    typeof source.subAgent === "object" &&
    "thread_spawn" in source.subAgent
      ? source.subAgent.thread_spawn
      : undefined;
  return thread.parentThreadId?.trim() ?? spawn?.parent_thread_id.trim();
}

/** Resolves history from the parent binding's native store without adopting the child. */
export async function readCodexNativeSubagentHistory(
  params: TaskHistoryParams,
  options: { bindingStore: CodexAppServerBindingStore; pluginConfig?: unknown },
) {
  params.assertCurrent();
  const { task, cfg } = params;
  const sessionKey = task.requesterSessionKey;
  const agentId = task.agentId;
  const threadId = task.runId?.startsWith(CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX)
    ? task.runId.slice(CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX.length)
    : undefined;
  if (task.taskKind !== CODEX_NATIVE_SUBAGENT_TASK_KIND || !sessionKey || !agentId || !threadId) {
    throw new Error("Subagent transcript owner is unavailable.");
  }
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const readSession = () =>
    getSessionEntry({
      agentId,
      sessionKey,
      storePath,
      hydrateSkillPromptRefs: false,
      readConsistency: "latest",
    });
  const session = readSession();
  if (!session?.sessionId) {
    throw new Error("Subagent parent session is unavailable.");
  }
  const sessionId = session.sessionId;
  const lifecycleRevision = session.lifecycleRevision;
  const historyOwner = readCodexNativeSubagentHistoryOwner(task.detail);
  if (
    historyOwner &&
    (historyOwner.lifecycleRevision
      ? historyOwner.lifecycleRevision !== lifecycleRevision
      : historyOwner.sessionId !== sessionId)
  ) {
    throw new Error("Subagent history owner changed; reconnect its parent session.");
  }
  const identity = sessionBindingIdentity({
    agentId,
    sessionId,
    sessionKey,
    config: cfg,
  });
  const binding = options.bindingStore.read(identity);
  if (!binding || binding.pendingSupervisionBranch) {
    throw new Error("Subagent parent thread is unavailable.");
  }
  if (
    historyOwner &&
    historyOwner.connectionFingerprint !== codexNativeSubagentHistoryConnectionFingerprint(binding)
  ) {
    throw new Error("Subagent history owner changed; reconnect its parent session.");
  }
  // Completion delivery can start a fresh parent thread. Keep the child's original ancestry.
  // Existing tasks without this locator can still use their unchanged parent binding.
  const historyParentThreadId = historyOwner?.parentThreadId ?? binding.threadId;
  const assertCurrent = () => {
    params.assertCurrent();
    const currentSession = readSession();
    const current = options.bindingStore.read(identity);
    if (
      currentSession?.sessionId !== sessionId ||
      currentSession?.lifecycleRevision !== lifecycleRevision ||
      current?.threadId !== binding.threadId ||
      current?.appServerRuntimeFingerprint !== binding.appServerRuntimeFingerprint ||
      current?.connectionScope !== binding.connectionScope ||
      current?.authProfileId !== binding.authProfileId
    ) {
      throw new Error("Subagent parent changed; refresh its transcript.");
    }
  };
  const agentDir = resolveAgentDir(cfg, agentId);
  const connection = resolveCodexBindingAppServerConnection({
    binding,
    pluginConfig: options.pluginConfig,
    agentDir,
    authProfileId: binding.authProfileId,
  });
  const client = await getLeasedSharedCodexAppServerClient({
    startOptions: connection.appServer.start,
    timeoutMs: connection.appServer.requestTimeoutMs,
    authProfileId: connection.clientAuthProfileId,
    agentDir,
    config: cfg,
    assertCurrent,
  });
  try {
    assertCurrent();
    const fingerprint =
      binding.connectionScope === "supervision"
        ? buildCodexAppServerConnectionFingerprint(connection.appServer, agentDir)
        : buildCodexAppServerRuntimeFingerprint({
            appServer: connection.appServer,
            appServerVersion: client.getServerVersion(),
            runtimeIdentity: client.getRuntimeIdentity(),
          });
    if (
      !binding.appServerRuntimeFingerprint ||
      fingerprint !== binding.appServerRuntimeFingerprint
    ) {
      throw new Error("Subagent connection changed; reconnect its parent session.");
    }
    const read = async <M extends "thread/read" | "thread/items/list" | "thread/turns/list">(
      method: M,
      request: CodexAppServerRequestParams<M>,
    ) => {
      assertCurrent();
      const result = await client.request(method, request, { assertCurrent });
      assertCurrent();
      return result;
    };
    const { thread } = await read("thread/read", { threadId, includeTurns: false });
    if (thread.id !== threadId || threadId === historyParentThreadId) {
      throw new Error("Subagent transcript does not belong to this parent session.");
    }
    // Nested children share the OpenClaw requester, but native lineage records their immediate parent.
    const visited = new Set([threadId]);
    let ancestor = thread;
    for (;;) {
      const parentId = parentThreadId(ancestor);
      if (parentId === historyParentThreadId) {
        break;
      }
      if (!parentId || visited.has(parentId) || visited.size >= MAX_SUBAGENT_ANCESTRY_READS) {
        throw new Error("Subagent transcript does not belong to this parent session.");
      }
      visited.add(parentId);
      const response = await read("thread/read", { threadId: parentId, includeTurns: false });
      if (response.thread.id !== parentId) {
        throw new Error("Subagent transcript does not belong to this parent session.");
      }
      ancestor = response.thread;
    }
    const page = await readCodexThreadHistoryPage(
      {
        listItemPage: (request) => read("thread/items/list", request),
        listTurnPage: (request) => read("thread/turns/list", request),
      },
      thread,
      {
        threadId,
        cursor: params.cursor,
        // One tool item can yield both a call and a result; keep both on the same page.
        limit: Math.max(1, Math.floor(Math.min(params.limit, 200) / 2)),
      },
      {
        project: (entries) =>
          entries.map((entry) =>
            projectCodexThreadHistoryItem(thread, entry, taskHistoryToolItems).map((message) => {
              const messageIdentity = readMirrorIdentity(message);
              if (!messageIdentity) {
                throw new Error("Subagent history message is missing its native identity.");
              }
              // The shared transcript reader uses messageId to merge live and older pages.
              return Object.assign(message, {
                messageId: JSON.stringify([threadId, messageIdentity]),
              });
            }),
          ),
        fits: (result) => Buffer.byteLength(JSON.stringify(result), "utf8") <= 512 * 1024,
      },
    );
    assertCurrent();
    return {
      messages: page.items.toReversed().flat(),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  } finally {
    releaseLeasedSharedCodexAppServerClient(client);
  }
}

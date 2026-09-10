import type { AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveCodexBindingAppServerConnection } from "./binding-connection.js";
import { itemToolArgs, itemTranscriptResultText } from "./event-projector-tool-items.js";
import {
  CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX,
  CODEX_NATIVE_SUBAGENT_TASK_KIND,
} from "./native-subagent-task-ids.js";
import {
  buildCodexAppServerConnectionFingerprint,
  buildCodexAppServerRuntimeFingerprint,
} from "./plugin-app-cache-key.js";
import type { CodexThread } from "./protocol.js";
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
  const identity = sessionBindingIdentity({
    agentId,
    sessionId: session.sessionId,
    sessionKey,
    config: cfg,
  });
  const binding = options.bindingStore.read(identity);
  if (!binding || binding.pendingSupervisionBranch) {
    throw new Error("Subagent parent thread is unavailable.");
  }
  const assertCurrent = () => {
    params.assertCurrent();
    const current = options.bindingStore.read(identity);
    if (
      readSession()?.sessionId !== session.sessionId ||
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
    const { thread } = await client.request(
      "thread/read",
      { threadId, includeTurns: false },
      { assertCurrent },
    );
    assertCurrent();
    if (thread.id !== threadId || threadId === binding.threadId) {
      throw new Error("Subagent transcript does not belong to this parent session.");
    }
    // Nested children share the OpenClaw requester, but native lineage records their immediate parent.
    const visited = new Set([threadId]);
    let ancestor = thread;
    for (;;) {
      const parentId = parentThreadId(ancestor);
      if (parentId === binding.threadId) {
        break;
      }
      if (!parentId || visited.has(parentId) || visited.size >= MAX_SUBAGENT_ANCESTRY_READS) {
        throw new Error("Subagent transcript does not belong to this parent session.");
      }
      visited.add(parentId);
      const response = await client.request(
        "thread/read",
        { threadId: parentId, includeTurns: false },
        { assertCurrent },
      );
      assertCurrent();
      if (response.thread.id !== parentId) {
        throw new Error("Subagent transcript does not belong to this parent session.");
      }
      ancestor = response.thread;
    }
    const page = await readCodexThreadHistoryPage(
      {
        listItemPage: async (request) => {
          assertCurrent();
          const result = await client.request("thread/items/list", request, { assertCurrent });
          assertCurrent();
          return result;
        },
        listTurnPage: async (request) => {
          assertCurrent();
          const result = await client.request("thread/turns/list", request, { assertCurrent });
          assertCurrent();
          return result;
        },
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

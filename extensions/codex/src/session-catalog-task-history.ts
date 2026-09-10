import { createHash } from "node:crypto";
import { resolveAgentDir } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { SessionCatalogProvider } from "openclaw/plugin-sdk/session-catalog";
import { resolveCodexBindingAppServerConnection } from "./app-server/binding-connection.js";
import {
  CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX,
  CODEX_NATIVE_SUBAGENT_TASK_KIND,
} from "./app-server/native-subagent-task-ids.js";
import {
  buildCodexAppServerRuntimeFingerprint,
  buildCodexAppServerConnectionFingerprint,
} from "./app-server/plugin-app-cache-key.js";
import { sessionBindingIdentity } from "./app-server/session-binding-record.js";
import type { CodexAppServerBindingStore } from "./app-server/session-binding.js";
import { CatalogParamsError, DEFAULT_TRANSCRIPT_PAGE_LIMIT } from "./session-catalog-parsing.js";
import { readVerifiedCodexTranscriptPage } from "./session-catalog-transcript.js";
import type { CodexSessionCatalogControlFactory } from "./session-catalog-types.js";

/** Native task access never expands the interactive session catalog's eligibility. */
export function createCodexTaskHistory(params: {
  api: OpenClawPluginApi;
  bindingStore: CodexAppServerBindingStore;
  control: CodexSessionCatalogControlFactory;
  getRuntimeConfig: () => OpenClawConfig | undefined;
  getPluginConfig: () => unknown;
}): NonNullable<SessionCatalogProvider["taskHistory"]> {
  return {
    taskKinds: [CODEX_NATIVE_SUBAGENT_TASK_KIND],
    async read(request) {
      if (
        request.taskKind !== CODEX_NATIVE_SUBAGENT_TASK_KIND ||
        !request.runId?.startsWith(CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX)
      ) {
        throw new CatalogParamsError("Codex task transcript is unavailable");
      }
      const threadId = request.runId.slice(CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX.length);
      if (!threadId.trim()) {
        throw new CatalogParamsError("Codex task transcript is unavailable");
      }
      const readBinding = () => {
        const config = params.getRuntimeConfig();
        const entry = params.api.runtime.agent.session.getSessionEntry({
          agentId: request.requesterAgentId,
          sessionKey: request.requesterSessionKey,
          readConsistency: "latest",
        });
        if (!entry?.sessionId?.trim()) {
          throw new CatalogParamsError("Codex task parent session is unavailable");
        }
        const identity = sessionBindingIdentity({
          sessionId: entry.sessionId,
          sessionKey: request.requesterSessionKey,
          agentId: request.requesterAgentId,
          config,
        });
        return { identity, binding: params.bindingStore.read(identity) };
      };
      const { identity, binding } = readBinding();
      const fingerprint = binding?.appServerRuntimeFingerprint;
      if (!binding || !fingerprint || binding.threadId === threadId) {
        throw new CatalogParamsError("Codex task parent binding is unavailable");
      }
      const config = params.getRuntimeConfig();
      const pluginConfig = params.getPluginConfig();
      const supervised = binding.connectionScope === "supervision";
      const agentDir = resolveAgentDir(config ?? {}, identity.agentId);
      // Supervised sources must remain in the configured catalog snapshot. Managed
      // sources use the runtime owner, not the ambient user-home catalog default.
      const supervisedHome = supervised
        ? params.control
            .homesForAgent(identity.agentId)
            .find(
              (home) =>
                !(request.allowProcessHomeFallback === false && home.usesProcessHomeFallback) &&
                buildCodexAppServerConnectionFingerprint(home.appServer, home.agentDir) ===
                  fingerprint,
            )
        : undefined;
      if (supervised && !supervisedHome) {
        throw new CatalogParamsError("Codex task source home is unavailable");
      }
      const appServer =
        supervisedHome?.appServer ??
        resolveCodexBindingAppServerConnection({
          binding,
          config,
          pluginConfig,
          agentDir,
        }).appServer;
      if (
        request.allowProcessHomeFallback === false &&
        appServer.start.transport === "stdio" &&
        appServer.start.homeScope === "user" &&
        !appServer.start.env?.CODEX_HOME?.trim() &&
        !process.env.CODEX_HOME?.trim()
      ) {
        throw new CatalogParamsError("Codex task source home is unavailable");
      }
      const home = supervisedHome ?? {
        hostId: "task-source",
        sourceHomeId: createHash("sha256").update(fingerprint).digest("hex"),
        label: "Task source",
        agentDir,
        appServer,
        usesProcessHomeFallback: false,
      };
      const control = params.control.forRequest(identity.agentId, home);
      return control.withPinnedConnection(async (pinned) => {
        const runtime = pinned.forkContext;
        const currentFingerprint = supervised
          ? pinned.connectionFingerprint
          : runtime &&
            buildCodexAppServerRuntimeFingerprint({
              appServer: runtime.appServer,
              appServerVersion: runtime.client.getServerVersion(),
              runtimeIdentity: runtime.client.getRuntimeIdentity(),
            });
        if (currentFingerprint !== fingerprint) {
          throw new CatalogParamsError("Codex task source connection changed");
        }
        const thread = await pinned.readThread(threadId, false);
        const source = thread.source;
        const subAgent =
          source && typeof source === "object" && "subAgent" in source
            ? source.subAgent
            : undefined;
        const spawn =
          subAgent && typeof subAgent === "object" && "thread_spawn" in subAgent
            ? subAgent.thread_spawn
            : undefined;
        if (thread.id !== threadId || spawn?.parent_thread_id !== binding.threadId) {
          throw new CatalogParamsError("Codex task thread does not belong to its parent");
        }
        const page = await readVerifiedCodexTranscriptPage(pinned, thread, {
          threadId,
          cursor: request.cursor,
          limit: request.limit ?? DEFAULT_TRANSCRIPT_PAGE_LIMIT,
        });
        // Reset/deletion/rebinding during I/O revokes this read, even on a pinned client.
        const latest = readBinding();
        if (
          latest.identity.sessionId !== identity.sessionId ||
          latest.binding?.threadId !== binding.threadId ||
          latest.binding?.appServerRuntimeFingerprint !== fingerprint ||
          latest.binding?.connectionScope !== binding.connectionScope ||
          params.getRuntimeConfig() !== config ||
          (supervised && !params.control.homesForAgent(identity.agentId).includes(home))
        ) {
          throw new CatalogParamsError("Codex task parent binding changed; refresh the task");
        }
        return {
          hostId: home.hostId,
          threadId,
          items: page.items
            .filter((item) => item.type !== "reasoning")
            .map(({ raw: _raw, ...item }) => {
              if (!item.id?.trim()) {
                throw new CatalogParamsError("Codex task item identity is unavailable");
              }
              return Object.assign(item, { id: item.id });
            }),
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        };
      });
    },
  };
}

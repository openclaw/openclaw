/**
 * Owner-only access to native Codex threads stored in the user's Codex home.
 */
import { isDeepStrictEqual } from "node:util";
import { resolveSessionAgentIdsStrict } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { AnyAgentTool, PluginRuntime } from "openclaw/plugin-sdk/core";
import { readStringParam } from "openclaw/plugin-sdk/param-readers";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  composeSessionEntryCommitGuards,
  type captureSessionEntryCurrentCheckAsync,
} from "openclaw/plugin-sdk/session-binding-runtime";
import {
  asBoolean,
  asOptionalRecord,
  asSafeIntegerInRange,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { jsonResult } from "openclaw/plugin-sdk/tool-results";
import { Type, type TProperties } from "typebox";
import { CODEX_CONTROL_METHODS, type CodexControlMethod } from "./app-server/capabilities.js";
import { readCodexPluginConfig } from "./app-server/config-parsing.js";
import {
  CODEX_INTERACTIVE_THREAD_SOURCE_KINDS,
  isJsonObject,
  type CodexAppServerRequestMethod,
  type CodexAppServerRequestParams,
  type JsonValue,
} from "./app-server/protocol.js";
import {
  assertCodexBindingMayBeReplaced,
  sessionBindingIdentity,
} from "./app-server/session-binding-record.js";
import type { CodexAppServerBindingStore } from "./app-server/session-binding.js";
import { assertCodexArchiveDescendantsUnowned } from "./app-server/thread-archive-guard.js";
import type { codexControlRequest, CodexControlRequestOptions } from "./command-rpc.js";

function threadActionSchema<Action extends string, Properties extends TProperties>(
  action: Action,
  properties: Properties,
) {
  return Type.Object(
    { action: Type.Literal(action), ...properties },
    { additionalProperties: false },
  );
}

const CodexThreadsParamsSchema = Type.Union([
  threadActionSchema("list", {
    archived: Type.Optional(Type.Boolean()),
    cursor: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    search: Type.Optional(Type.String()),
  }),
  threadActionSchema("read", {
    thread_id: Type.String(),
    include_turns: Type.Optional(Type.Boolean()),
  }),
  threadActionSchema("fork", {
    thread_id: Type.String(),
    attach: Type.Optional(
      Type.Boolean({
        default: true,
        description: "Attach the fork to this OpenClaw session for its next turn.",
      }),
    ),
  }),
  threadActionSchema("rename", {
    thread_id: Type.String(),
    name: Type.String(),
  }),
  threadActionSchema("archive", {
    thread_id: Type.String(),
    confirm: Type.Literal(true, {
      description: "Required acknowledgement that the thread is closed in other Codex clients.",
    }),
  }),
  threadActionSchema("unarchive", {
    thread_id: Type.String(),
  }),
]);

type CodexThreadsToolOptions = {
  bindingStore: CodexAppServerBindingStore;
  context: OpenClawPluginToolContext;
  runtime: PluginRuntime;
  getPluginConfig: () => unknown;
  request?: typeof codexControlRequest;
};

function readThreadId(params: Record<string, unknown>): string {
  return readStringParam(params, "thread_id", { required: true, label: "thread_id" });
}

function assertThreadIdle(
  value: unknown,
  expectedThreadId: string,
  action: "archive" | "fork",
): void {
  if (!isJsonObject(value) || !isJsonObject(value.thread)) {
    throw new Error("Codex app-server returned an invalid thread/read response");
  }
  if (value.thread.id !== expectedThreadId) {
    throw new Error("Codex app-server returned a different thread than requested");
  }
  const status = isJsonObject(value.thread.status) ? value.thread.status.type : undefined;
  if (action === "archive" && status === "active") {
    throw new Error("cannot archive an active Codex thread; wait for its turn to finish");
  }
  if (status !== "idle" && status !== "notLoaded") {
    throw new Error(
      action === "archive"
        ? "cannot verify that the Codex thread is idle; refusing to archive"
        : "cannot fork a Codex thread unless it is idle or not loaded",
    );
  }
}

function redactNativeThreadTranscriptFields(value: JsonValue): JsonValue {
  if (!isJsonObject(value)) {
    return value;
  }
  const redacted = { ...value };
  delete redacted.preview;
  delete redacted.turns;
  return redacted;
}

function redactNativeThreadResponse(value: unknown): unknown {
  if (!isJsonObject(value)) {
    return value;
  }
  const redacted = { ...value };
  if (Array.isArray(redacted.data)) {
    redacted.data = redacted.data.map(redactNativeThreadTranscriptFields);
  }
  if (isJsonObject(redacted.thread)) {
    redacted.thread = redactNativeThreadTranscriptFields(redacted.thread);
  }
  return redacted;
}

/** Builds the native Codex thread tool only for owner runs with native-home access. */
export function createCodexThreadsTool(options: CodexThreadsToolOptions): AnyAgentTool | null {
  if (options.context.senderIsOwner !== true) {
    return null;
  }
  const configured = readCodexPluginConfig(options.getPluginConfig());
  if (configured.appServer?.homeScope !== "user" && configured.supervision?.enabled !== true) {
    return null;
  }

  return {
    name: "codex_threads",
    label: "Codex Threads",
    description:
      "Manage native Codex threads: list, read, fork, rename, archive (confirm:true), unarchive. When supervision is enabled, raw transcript reads and every mutation require their matching supervision policy option.",
    parameters: CodexThreadsParamsSchema,
    async execute(_toolCallId, rawParams) {
      const runtimeConfig = () =>
        options.context.getRuntimeConfig?.() ??
        options.context.runtimeConfig ??
        options.context.config;
      const context = options.context;
      const sessionKey = context.sessionKey?.trim();
      const config = runtimeConfig();
      const agentId = sessionKey
        ? resolveSessionAgentIdsStrict({
            config: config ?? {},
            sessionKey,
            agentId: context.agentId,
          }).sessionAgentId
        : undefined;
      const storePath = agentId
        ? options.runtime.agent.session.resolveStorePath(config?.session?.store, { agentId })
        : undefined;
      let prepared: Awaited<ReturnType<typeof captureSessionEntryCurrentCheckAsync>> | undefined;
      const currentSession = () => {
        if (!sessionKey) {
          return undefined;
        }
        const entry = prepared?.entry;
        const sessionId = context.sessionId?.trim() || entry?.sessionId?.trim();
        if (!sessionId) {
          return undefined;
        }
        return {
          sessionId,
          // Lock policy loads later; keep the session fields observed at admission.
          entry: entry ? { ...entry } : undefined,
        };
      };

      const currentIdentity = (sessionId: string) =>
        sessionBindingIdentity({
          sessionId,
          sessionKey: options.context.sessionKey,
          agentId: options.context.agentId,
          config: runtimeConfig(),
        });
      const currentBinding = (session: ReturnType<typeof currentSession>) =>
        session ? options.bindingStore.read(currentIdentity(session.sessionId)) : undefined;
      const params = asOptionalRecord(rawParams) ?? {};
      const action = readStringParam(params, "action", { required: true, label: "action" });
      const admissionConfig = options.getPluginConfig();
      const admissionPlugin = readCodexPluginConfig(admissionConfig);
      const supervision = admissionPlugin.supervision;
      const mayReadRawTranscripts =
        supervision?.enabled !== true || supervision.allowRawTranscripts === true;
      const threadResult = (response: unknown) =>
        jsonResult(mayReadRawTranscripts ? response : redactNativeThreadResponse(response));

      const isMutation =
        action === "fork" || action === "rename" || action === "archive" || action === "unarchive";
      if (isMutation && supervision?.enabled === true && supervision.allowWriteControls !== true) {
        throw new Error(
          "Codex native thread mutations are disabled for this codex plugin supervision config.",
        );
      }
      const run = async (archiveThreadId?: string) => {
        const { captureSessionEntryCurrentCheckAsync } =
          await import("openclaw/plugin-sdk/session-binding-runtime");
        prepared =
          sessionKey && agentId
            ? await captureSessionEntryCurrentCheckAsync({
                agentId,
                sessionKey,
                storePath,
                fields: ["modelSelectionLocked"],
                errorMessage: "Codex native thread ownership changed; retry the request.",
              })
            : undefined;
        options.context.assertInvocationCurrent?.();
        const archiveSession = archiveThreadId ? currentSession() : undefined;
        if (archiveThreadId && !archiveSession) {
          throw new Error("cannot safely archive a native Codex thread without a session identity");
        }
        const archiveAdmission =
          archiveThreadId && archiveSession
            ? {
                threadId: archiveThreadId,
                session: archiveSession,
                identity: currentIdentity(archiveSession.sessionId),
              }
            : undefined;
        const request = options.request ?? (await import("./command-rpc.js")).codexControlRequest;
        const { isModelSelectionLocked, ModelSelectionLockedError } =
          await import("openclaw/plugin-sdk/model-session-runtime");
        const { codexBindingConnectionSelection, resolveCodexBindingAppServerConnection } =
          await import("./app-server/binding-connection.js");
        const { resolveCodexSupervisionAppServerRuntimeOptions } =
          await import("./app-server/config-runtime.js");
        const requestOptions = async (): Promise<CodexControlRequestOptions> => {
          const base = {
            agentId,
            agentDir: options.context.agentDir,
            config: runtimeConfig(),
            sessionId: options.context.sessionId,
            sessionKey: options.context.sessionKey,
            storePath,
          };
          const session = currentSession();
          const identity = session ? currentIdentity(session.sessionId) : undefined;
          const readBinding = () => (identity ? options.bindingStore.read(identity) : undefined);
          const binding = identity ? await options.bindingStore.readAsync(identity) : undefined;
          const selection = codexBindingConnectionSelection(binding);
          const assertCurrent = () => {
            options.context.assertInvocationCurrent?.();
            const current = currentSession();
            if (
              runtimeConfig() !== base.config ||
              !isDeepStrictEqual(options.getPluginConfig(), admissionConfig) ||
              current?.sessionId !== session?.sessionId ||
              !isDeepStrictEqual(codexBindingConnectionSelection(readBinding()), selection)
            ) {
              throw new Error("Codex native thread ownership changed; retry the request.");
            }
          };
          if (
            binding?.connectionScope === "supervision" ||
            admissionPlugin.appServer?.homeScope === "user"
          ) {
            const connection = await resolveCodexBindingAppServerConnection({
              binding,
              pluginConfig: admissionConfig,
              config: base.config,
              agentDir: base.agentDir,
              assertCurrent,
            });
            return {
              ...base,
              startOptions: connection.appServer.start,
              authProfileId: connection.usesSupervisionConnection
                ? connection.clientAuthProfileId
                : null,
              assertCurrent,
              assertCurrentAsync: prepared?.assertCurrent,
            };
          }
          if (supervision?.enabled !== true) {
            throw new Error("Codex native thread access is disabled for this run.");
          }
          return {
            ...base,
            startOptions: resolveCodexSupervisionAppServerRuntimeOptions({
              pluginConfig: admissionConfig,
            }).start,
            authProfileId: null,
            assertCurrent,
            assertCurrentAsync: prepared?.assertCurrent,
          };
        };
        const scopedRequest = async <M extends CodexControlMethod & CodexAppServerRequestMethod>(
          method: M,
          requestParams: CodexAppServerRequestParams<M>,
        ) => request(admissionConfig, method, requestParams, await requestOptions());
        if (action === "list") {
          const cursor = readStringParam(params, "cursor");
          const searchTerm = readStringParam(params, "search");
          if (searchTerm && !mayReadRawTranscripts) {
            throw new Error(
              "Codex native thread search is disabled while raw transcript access is disabled.",
            );
          }
          const response = await scopedRequest(CODEX_CONTROL_METHODS.listThreads, {
            archived: asBoolean(params.archived) ?? false,
            limit: asSafeIntegerInRange(params.limit, { min: 1, max: 100 }) ?? 20,
            modelProviders: [],
            sortKey: "recency_at",
            sortDirection: "desc",
            sourceKinds: [...CODEX_INTERACTIVE_THREAD_SOURCE_KINDS],
            ...(cursor ? { cursor } : {}),
            ...(searchTerm ? { searchTerm } : {}),
          });
          return threadResult(response);
        }

        const threadId = archiveAdmission?.threadId ?? readThreadId(params);
        if (action === "read") {
          const includeTurns = asBoolean(params.include_turns) ?? false;
          if (includeTurns && !mayReadRawTranscripts) {
            throw new Error(
              "Codex raw transcript reads are disabled for this codex plugin supervision config.",
            );
          }
          const response = await scopedRequest(CODEX_CONTROL_METHODS.readThread, {
            threadId,
            includeTurns,
          });
          return threadResult(response);
        }
        if (action === "rename") {
          const name = readStringParam(params, "name", { required: true, label: "name" });
          await scopedRequest(CODEX_CONTROL_METHODS.renameThread, { threadId, name });
          return jsonResult({ action, threadId, name });
        }
        if (action === "unarchive") {
          const response = await scopedRequest(CODEX_CONTROL_METHODS.unarchiveThread, { threadId });
          return threadResult(response);
        }

        const session = archiveAdmission?.session ?? currentSession();
        const binding = session
          ? await options.bindingStore.readAsync(currentIdentity(session.sessionId))
          : undefined;
        if (archiveAdmission) {
          const { identity, session: admittedSession } = archiveAdmission;
          const archivedBinding = binding;
          if (archivedBinding?.threadId === threadId) {
            // Clearing the binding detaches the harness-owned Codex thread. The session lock keeps
            // both that thread and App Server-selected model routing fixed.
            if (isModelSelectionLocked(admittedSession.entry)) {
              throw new ModelSelectionLockedError();
            }
            assertCodexBindingMayBeReplaced(archivedBinding, "archiving its bound native thread");
          }
          // App Server status is process-local, and archive is a separate RPC. This read blocks
          // known active/invalid state; `confirm` owns the remaining cross-client race.
          const assertArchiveThreadIdle = async (targetThreadId: string) => {
            const current = await scopedRequest(CODEX_CONTROL_METHODS.readThread, {
              threadId: targetThreadId,
              includeTurns: false,
            });
            assertThreadIdle(current, targetThreadId, "archive");
          };
          await assertArchiveThreadIdle(threadId);
          if (await options.bindingStore.hasOtherThreadOwner(threadId, identity)) {
            throw new Error(
              "cannot archive a native Codex thread owned by another OpenClaw session",
            );
          }
          await assertCodexArchiveDescendantsUnowned({
            bindingStore: options.bindingStore,
            threadId,
            listPage: async (listParams) =>
              await scopedRequest(CODEX_CONTROL_METHODS.listThreads, listParams),
            assertDescendantIdle: assertArchiveThreadIdle,
          });
          await scopedRequest(CODEX_CONTROL_METHODS.archiveThread, { threadId });
          if (archivedBinding?.threadId === threadId) {
            await options.bindingStore.mutate(
              identity,
              {
                kind: "clear",
                threadId,
              },
              composeSessionEntryCommitGuards([
                options.context.assertInvocationCurrent,
                prepared?.source,
              ]),
            );
          }
          return jsonResult({ action, threadId });
        }
        if (action !== "fork") {
          throw new Error(`unsupported codex_threads action: ${action}`);
        }

        const attach = asBoolean(params.attach) ?? true;
        if (attach && !session) {
          throw new Error("cannot attach a Codex fork without an active OpenClaw session");
        }
        if (attach && isModelSelectionLocked(session?.entry)) {
          throw new ModelSelectionLockedError();
        }
        const usesSupervisionConnection =
          binding?.connectionScope === "supervision" ||
          (admissionPlugin.appServer?.homeScope !== "user" && supervision?.enabled === true);
        if (attach && usesSupervisionConnection) {
          throw new Error("Supervised Codex forks must stay detached; set attach=false.");
        }
        const forkOptions = await requestOptions();
        const {
          retainCodexAppServerBindingSubscription,
          rollbackCodexAppServerBindingSubscription,
        } = await import("./app-server/thread-ownership.js");
        const { closeCodexStartupClientBestEffort } =
          await import("./app-server/attempt-client-cleanup.js");
        if (attach) {
          assertCodexBindingMayBeReplaced(binding, "attaching a different native fork");
          // Codex can snapshot an active source as interrupted. Attached forks require a known-safe
          // local status and the exact source identity before App Server may create that snapshot.
          const current = await request(
            admissionConfig,
            CODEX_CONTROL_METHODS.readThread,
            { threadId, includeTurns: false },
            forkOptions,
          );
          assertThreadIdle(current, threadId, "fork");
        }
        const response = await request(
          admissionConfig,
          CODEX_CONTROL_METHODS.forkThread,
          { threadId, threadSource: "user", excludeTurns: true },
          {
            ...forkOptions,
            onResponse: async (value, client, { assertCurrent, assertCurrentAsync, source }) => {
              if (!isJsonObject(value) || !isJsonObject(value.thread)) {
                await closeCodexStartupClientBestEffort(client);
                throw new Error("Codex app-server returned an invalid thread/fork response");
              }
              const forkThread = value.thread;
              const forkThreadId =
                typeof forkThread.id === "string" && forkThread.id.trim()
                  ? forkThread.id
                  : undefined;
              if (!forkThreadId) {
                await closeCodexStartupClientBestEffort(client);
                throw new Error(
                  "Codex app-server thread/fork response did not include a thread id",
                );
              }
              let retained = false;
              let attached = false;
              try {
                await assertCurrentAsync?.();
                assertCurrent();
                if (attach && session) {
                  const identity = currentIdentity(session.sessionId);
                  await options.bindingStore.withLease(identity, async () => {
                    await assertCurrentAsync?.();
                    assertCurrent();
                    assertCodexBindingMayBeReplaced(
                      currentBinding(session),
                      "attaching a different native fork",
                    );
                    retained = await retainCodexAppServerBindingSubscription(client, forkThreadId);
                    if (!retained) {
                      throw new Error("Codex fork lost its native subscription owner.");
                    }
                    const nextBinding = {
                      threadId: forkThreadId,
                      clientId: client.getInstanceId(),
                      cwd:
                        typeof forkThread.cwd === "string"
                          ? forkThread.cwd
                          : (options.context.workspaceDir ?? ""),
                      model: typeof value.model === "string" ? value.model : undefined,
                      modelProvider:
                        typeof value.modelProvider === "string" ? value.modelProvider : undefined,
                      historyCoveredThrough: new Date().toISOString(),
                    };
                    // The calling turn keeps its claim; only the next-turn binding moves to this fork.
                    attached = await options.bindingStore.mutate(
                      identity,
                      { kind: "set", binding: nextBinding },
                      composeSessionEntryCommitGuards([assertCurrent, source, prepared?.source]),
                    );
                    if (!attached) {
                      throw new Error(
                        "Codex session binding changed before the fork could be attached",
                      );
                    }
                  });
                }
              } finally {
                if (!attached) {
                  await rollbackCodexAppServerBindingSubscription(client, forkThreadId, retained);
                }
              }
            },
          },
        );
        const result = {
          action,
          sourceThreadId: threadId,
          thread: response.thread,
          attached: attach,
        };
        return threadResult(result);
      };
      if (action === "archive") {
        const threadId = readThreadId(params);
        if (params.confirm !== true) {
          throw new Error("confirm=true is required to archive a native Codex thread");
        }
        // The binding store reserves archive ownership synchronously. Do not let
        // cold execution imports yield before later mutations are fenced out.
        return options.bindingStore.withThreadArchiveFence(() => run(threadId));
      }
      return run();
    },
  };
}

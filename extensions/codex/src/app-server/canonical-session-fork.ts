import { isDeepStrictEqual } from "node:util";
import { embeddedAgentLog, type AgentHarnessV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessagesByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { readCodexSessionMeta } from "../session-catalog-provenance.js";
import type { CodexSessionCatalogControl } from "../session-catalog-types.js";
import { codexUpstreamBaseline } from "../session-upstream-marker.js";
import { CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS } from "./attempt-client-cleanup.js";
import { prepareCanonicalCodexFork } from "./canonical-fork-preparation.js";
import { claimCodexAppServerLiveThread, hasCodexAppServerLiveThread } from "./client-runtime.js";
import { wasCodexAppServerThreadClosed } from "./client-thread-closure.js";
import type { CodexAppServerLiveThreadOwnership } from "./client-thread-owner.js";
import type { CodexAppServerClient } from "./client.js";
import { parseCodexNativeToolCatalog } from "./native-tool-catalog.js";
import { checkCodexThreadAppAvailability } from "./plugin-thread-attestation.js";
import { assertCodexThreadForkResponse } from "./protocol-validators.js";
import { flattenCodexDynamicToolFunctions, isJsonObject } from "./protocol.js";
import { CodexAppServerScopedRequestRejectedError } from "./request.js";
import {
  sessionBindingIdentity,
  type CodexAppServerBindingStore,
  type CodexAppServerThreadBinding,
} from "./session-binding.js";
import { prepareCodexSessionInitialization } from "./session-initialization.js";
import { codexDynamicToolsFingerprint } from "./thread-fingerprints.js";
import { withCodexAppServerThreadMutation } from "./thread-ownership.js";
import { CodexThreadPolicyHandoffError, refreshCodexThreadPolicy } from "./thread-policy.js";
import {
  listCodexUpstreamTurns,
  type CodexUpstreamForkBoundaryResult,
} from "./upstream-fork-boundary.js";

type Boundary = Extract<CodexUpstreamForkBoundaryResult, { ok: true }> & {
  canonical: NonNullable<Extract<CodexUpstreamForkBoundaryResult, { ok: true }>["canonical"]>;
};

/** Resolves once the connection closes the thread or exits; both drop its writer lock. */
function waitForCodexForkUnload(client: CodexAppServerClient, threadId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (unloaded: boolean) => {
      clearTimeout(timer);
      stopNotifications();
      stopClose();
      resolve(unloaded);
    };
    const timer = setTimeout(() => finish(false), CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS);
    const stopNotifications = client.addNotificationHandler((notification) => {
      if (
        notification.method === "thread/closed" &&
        isJsonObject(notification.params) &&
        notification.params.threadId === threadId
      ) {
        finish(true);
      }
    });
    const stopClose = client.addCloseHandler(() => finish(true));
    if (wasCodexAppServerThreadClosed(client, threadId) || client.getCloseError()) {
      finish(true);
    }
  });
}

/** Native history stays native; only the verified local display prefix is copied. */
export async function forkCanonicalCodexSession(params: {
  fork: Parameters<NonNullable<AgentHarnessV2["sessionForkV2"]>["fork"]>[0];
  resolved: Boundary;
  sourceBinding: CodexAppServerThreadBinding;
  control: CodexSessionCatalogControl;
  bindingStore: CodexAppServerBindingStore;
  runtime: PluginRuntime;
  harnessRuntimeId: string;
  config: OpenClawConfig;
}) {
  const { fork, resolved, control, bindingStore, sourceBinding, config } = params;
  const context = control.forkContext;
  if (!context?.localSessionsRoot || !resolved.canonical.thread.path) {
    throw new Error(
      "Forking an OpenClaw Codex session requires the verified local rollout on its selected connection. Fork an original imported message instead.",
    );
  }
  const model = normalizeOptionalString(resolved.canonical.thread.model);
  const modelProvider = normalizeOptionalString(resolved.canonical.thread.modelProvider);
  if (!model || !modelProvider) {
    throw new Error(
      "Codex did not report the source thread's model selection. Use Codex 0.153.0 or newer, or fork an original imported message instead.",
    );
  }
  const sourceIdentity = sessionBindingIdentity({ ...fork.source, config });
  return bindingStore.withLease(sourceIdentity, async () => {
    if (!isDeepStrictEqual(bindingStore.read(sourceIdentity), sourceBinding)) {
      throw new Error("Codex source binding changed before initialization");
    }
    let freshThreadId: string | undefined;
    let ownership: CodexAppServerLiveThreadOwnership | undefined;
    let ownershipTransferred = false;
    let policyWriteUncertain = false;
    const result = await params.runtime.agent.session
      .createSessionEntry({
        cfg: config,
        key: fork.targetKey,
        agentId: fork.source.agentId,
        spawnedCwd: resolved.canonical.thread.cwd ?? sourceBinding.cwd,
        initialEntry: { agentHarnessId: params.harnessRuntimeId, modelSelectionLocked: true },
        afterCreate: async (created) => {
          if (!created.initialization) {
            throw new Error("Forking an OpenClaw Codex session requires host creation authority");
          }
          const host = created.initialization;
          const initialization = prepareCodexSessionInitialization({
            initialization: host,
            bindingStore,
            identity: sessionBindingIdentity({
              agentId: created.agentId,
              sessionId: created.sessionId,
              sessionKey: created.key,
              config,
            }),
            assertCleanupAllowed: () => {
              // Unsubscribe/archive ACK cannot prove an in-flight injection stopped.
              // Keep the host's existing non-ready cleanup outcome for inspection.
              if (policyWriteUncertain) {
                throw new Error(
                  "Fresh Codex policy delivery is uncertain; cleanup could not be verified. Inspect the retained thread before retrying.",
                );
              }
            },
            prepareCleanup: () => async (assertCurrent) => {
              if (!freshThreadId) {
                return;
              }
              const threadId = freshThreadId;
              await withCodexAppServerThreadMutation(threadId, async () => {
                assertCurrent();
                if (!ownershipTransferred) {
                  if (!ownership) {
                    throw new Error(
                      "The fresh Codex fork has no verified subscription owner; inspect it before retrying.",
                    );
                  }
                  ownership.assertCurrent();
                }
                if (await bindingStore.hasOtherThreadOwner(threadId)) {
                  throw new Error("Codex fork cleanup refused: a successor owns the native thread");
                }
                assertCurrent();
                try {
                  await control.archiveThread(threadId, assertCurrent);
                } catch (cause) {
                  control.retireConnection?.();
                  throw new Error(
                    "Fresh Codex fork cleanup could not be verified; inspect the retained thread before retrying.",
                    { cause },
                  );
                }
                // Archive completed; its later notification owns local claim removal.
                ownershipTransferred = true;
                assertCurrent();
              });
            },
          });
          const assertCurrent = () => {
            fork.assertCurrent();
            initialization.assertCurrent();
            if (ownership && !ownershipTransferred) {
              ownership.assertCurrent();
            }
          };
          const metadata = await readCodexSessionMeta(
            context.localSessionsRoot!,
            resolved.canonical.thread.path!.replace(/\.zst$/, ""),
            sourceBinding.threadId,
            { canonicalSource: true },
          );
          assertCurrent();
          if (!metadata) {
            throw new Error("The source Codex rollout metadata could not be verified");
          }
          if (!sourceBinding.dynamicToolsFingerprint) {
            throw new Error("The source session has no verified native catalog binding");
          }
          const sourceCatalog = parseCodexNativeToolCatalog(
            metadata,
            sourceBinding.threadId,
            sourceBinding.dynamicToolsFingerprint,
          );
          const prepared = await prepareCanonicalCodexFork({
            created,
            initialization: host,
            config,
            context,
            model,
            modelProvider,
            sandbox: fork.sandbox,
            dynamicTools: sourceCatalog,
          });
          assertCurrent();
          if (!isDeepStrictEqual(bindingStore.read(sourceIdentity), sourceBinding)) {
            throw new Error("Codex source binding changed during preparation");
          }
          assertCurrent();
          let raw: unknown;
          try {
            raw = await control.forkThread(
              {
                ...prepared.request,
                // Lets readiness unload the child so its turn connection can take the writer.
                config: { ...prepared.request.config, thread_unload_delay_secs: 0 },
                threadId: sourceBinding.threadId,
                beforeTurnId: resolved.boundary.beforeTurnId,
                model,
                modelProvider,
                threadSource: "appServer",
                excludeTurns: true,
              },
              assertCurrent,
            );
          } catch (error) {
            // Rejected ownership never entered the wire; an unknown native outcome must retire it.
            if (!(error instanceof CodexAppServerScopedRequestRejectedError)) {
              control.retireConnection?.();
            }
            throw error;
          }
          let response;
          try {
            response = assertCodexThreadForkResponse(raw);
            if (
              !response.thread.id.trim() ||
              response.thread.id === sourceBinding.threadId ||
              response.thread.id === fork.upstream.threadId ||
              response.thread.forkedFromId !== sourceBinding.threadId ||
              (await bindingStore.hasOtherThreadOwner(response.thread.id))
            ) {
              throw new Error("Codex fork returned an unsafe native thread identity");
            }
          } catch (error) {
            control.retireConnection?.();
            throw error;
          }
          freshThreadId = response.thread.id;
          ownership = await claimCodexAppServerLiveThread(context.client, freshThreadId);
          if (!ownership) {
            control.retireConnection?.();
            throw new Error("Codex fork subscription ownership could not be acquired");
          }
          assertCurrent();
          // The initial selection and the child's current live settings must both match.
          if (
            response.model !== model ||
            response.thread.model !== model ||
            response.modelProvider !== modelProvider ||
            response.thread.modelProvider !== modelProvider
          ) {
            throw new Error(
              "Codex fork did not preserve the exact source session and selected native model",
            );
          }
          const turns = await listCodexUpstreamTurns(control, freshThreadId);
          assertCurrent();
          const cut = resolved.canonical.turns.findIndex(
            (turn) => turn.id === resolved.boundary.beforeTurnId,
          );
          if (cut < 0 || !isDeepStrictEqual(turns, resolved.canonical.turns.slice(0, cut))) {
            throw new Error(
              "Codex did not apply the exact beforeTurnId cut. Reconnect to a compatible server and retry.",
            );
          }
          const childMetadata = response.thread.path
            ? await readCodexSessionMeta(
                context.localSessionsRoot!,
                response.thread.path,
                freshThreadId,
              )
            : undefined;
          assertCurrent();
          if (!childMetadata || childMetadata.model_provider !== modelProvider) {
            throw new Error("The fresh Codex fork metadata could not be verified");
          }
          const childCatalog = parseCodexNativeToolCatalog(childMetadata, freshThreadId);
          if (!isDeepStrictEqual(sourceCatalog, childCatalog)) {
            throw new Error("Codex fork did not preserve the actual native tool catalog");
          }
          await checkCodexThreadAppAvailability({
            client: context.client,
            threadId: freshThreadId,
            appIds: prepared.provisionalAppIds,
          });
          assertCurrent();
          try {
            await refreshCodexThreadPolicy({
              client: context.client,
              threadId: freshThreadId,
              developerInstructions: prepared.request.developerInstructions,
              timeoutMs: context.appServer.requestTimeoutMs,
              assertCurrent,
            });
          } catch (error) {
            if (error instanceof CodexThreadPolicyHandoffError && error.outcome === "unknown") {
              policyWriteUncertain = true;
              control.retireConnection?.();
            }
            throw error;
          }
          await appendSessionTranscriptMessagesByIdentity({
            config,
            storePath: resolveStorePath(config.session?.store, { agentId: created.agentId }),
            agentId: created.agentId,
            sessionKey: created.key,
            sessionId: created.sessionId,
            messages: resolved.canonical.prefix.map((entry) => ({
              message: entry.message,
              idempotencyLookup: "scan" as const,
            })),
          });
          assertCurrent();
          await initialization.linkAsync({
            sessionKey: created.key,
            agentId: created.agentId,
            catalogId: fork.upstream.catalogId,
            hostId: fork.upstream.hostId,
            threadId: fork.upstream.threadId,
            upstreamKind: fork.upstream.kind,
            upstreamRef: fork.upstream.ref,
            marker: codexUpstreamBaseline({ ...response.thread, turns }, normalizeOptionalString),
          });
          await initialization.bind({
            threadId: freshThreadId,
            connectionScope: "supervision",
            supervisionSourceThreadId: fork.upstream.threadId,
            preserveNativeModel: true,
            conversationSourceTransferComplete: true,
            cwd: prepared.request.cwd ?? "",
            rolloutPath: response.thread.path ?? undefined,
            model,
            modelProvider,
            appServerRuntimeFingerprint: control.connectionFingerprint,
            dynamicToolsFingerprint: codexDynamicToolsFingerprint(childCatalog),
            dynamicToolsContainDeferred: flattenCodexDynamicToolFunctions(childCatalog).some(
              (tool) => tool.deferLoading === true,
            ),
            ...prepared.bindingPolicy,
            historyCoveredThrough: new Date().toISOString(),
          });
          assertCurrent();
          // Codex holds one writer lock per home while a thread is loaded, and the child's
          // turns run on the supervision turn connection, another process. Release this
          // catalog connection's writer before readiness; the fork's zero unload delay makes
          // unsubscribe close it. A missed close stays visible as the child's resume error.
          const unloaded = waitForCodexForkUnload(context.client, freshThreadId);
          // The close notification may invalidate the released claim before its ACK settles.
          await ownership.release(freshThreadId, () => {
            fork.assertCurrent();
            initialization.assertCurrent();
          });
          ownershipTransferred = true;
          if (!(await unloaded)) {
            embeddedAgentLog.warn("codex canonical fork did not unload before readiness", {
              threadId: freshThreadId,
            });
          }
          initialization.assertCurrent();
          if (!isDeepStrictEqual(bindingStore.read(sourceIdentity), sourceBinding)) {
            throw new Error("Codex source binding changed before fork readiness");
          }
          initialization.assertCurrent();
          return { pluginExtensions: created.entry.pluginExtensions };
        },
      })
      .finally(() => {
        // Host rollback may lose archive authority. Retire the captured subscription separately;
        // archive notifications already clear ordinary cleanup, and sibling leases still drain.
        if (
          freshThreadId &&
          !ownershipTransferred &&
          hasCodexAppServerLiveThread(context.client, freshThreadId)
        ) {
          control.retireConnection?.();
        }
      });
    return {
      status: "created" as const,
      key: result.key,
      ...(resolved.editorText !== undefined ? { editorText: resolved.editorText } : {}),
    };
  });
}

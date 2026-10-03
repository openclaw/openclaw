import { loadCodexBundleMcpThreadConfig } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  type AgentHarnessSessionPreparationV1,
  buildCodexUserMcpServersThreadConfigPatchForRuntime,
} from "openclaw/plugin-sdk/codex-mcp-projection";
import { loadExecApprovals } from "openclaw/plugin-sdk/exec-approvals-runtime";
import { z } from "zod";
import { resolveCodexAppServerAuthProfileId } from "./auth-profile.js";
import { resolveCodexBindingAppServerConnection } from "./binding-connection.js";
import { ensureCodexAppServerClientRuntime } from "./client-runtime.js";
import { resolveOpenClawExecPolicyForCodexAppServer } from "./config-exec-approvals.js";
import { readCodexPluginConfig } from "./config-parsing.js";
import { readCodexRequirementsToml } from "./config-requirements.js";
import { isCodexAppServerProxyLaunch } from "./launch-args.js";
import {
  buildCodexPluginAppCacheKey,
  buildCodexAppServerRuntimeFingerprint,
} from "./plugin-app-cache-key.js";
import {
  createCodexPluginThreadConfigStartupProvider,
  resolveCodexPluginThreadConfigStartupPolicy,
} from "./plugin-thread-config-deadline.js";
import {
  buildCodexPluginThreadConfigInputFingerprint,
  mergeCodexThreadConfigs,
} from "./plugin-thread-config.js";
import type { CodexAppServerBindingStore } from "./session-binding.js";
import { sessionBindingIdentity, resolveCodexSessionBinding } from "./session-binding.js";
import { applyCodexSessionPermissionPolicy } from "./session-permission-policy.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./shared-client.js";
import { startOrResumeThread } from "./thread-lifecycle.js";
import {
  isSameCodexAppServerThreadOwner,
  retainCodexAppServerBindingSubscription,
  rollbackCodexAppServerBindingSubscription,
} from "./thread-ownership.js";

/** Runs the existing thread lifecycle only. This path has no prompt or turn submission. */
export async function prepareCodexMcpAppSession(params: {
  preparation: AgentHarnessSessionPreparationV1;
  bindingStore: CodexAppServerBindingStore;
  pluginConfig?: unknown;
  assertCurrent: () => void;
}) {
  const { preparation } = params;
  if (preparation.version !== 1 || preparation.purpose !== "mcp-app") {
    throw new Error("Unsupported native session preparation capability");
  }
  return preparation.run(async () => {
    const input = preparation.params;
    const assertSourceCurrent = () => {
      params.assertCurrent();
      input.hostCapabilities.assertActive();
      input.abortSignal?.throwIfAborted();
    };
    assertSourceCurrent();
    const pluginConfig = readCodexPluginConfig(params.pluginConfig);
    const admitted = await resolveCodexSessionBinding({
      bindingStore: params.bindingStore,
      identity: sessionBindingIdentity(input),
      config: input.config,
      storePath: input.sessionTarget?.storePath,
      reclaimStale: true,
      signal: input.abortSignal,
      assertCurrent: assertSourceCurrent,
    });
    const assertCurrent = () => {
      assertSourceCurrent();
      admitted.assertCurrent();
    };
    assertCurrent();
    const prepareThread = async () => {
      const execPolicy = resolveOpenClawExecPolicyForCodexAppServer({
        permissionMode: input.permissionMode,
        execOverrides: input.execOverrides,
        approvals: input.permissionMode === "full" ? undefined : loadExecApprovals(),
        config: input.config,
        agentId: input.agentId,
      });
      const { appServer: runtimeOptions } = await resolveCodexBindingAppServerConnection({
        binding: admitted.binding,
        pluginConfig,
        execPolicy,
        modelProvider: input.provider,
        model: input.modelId,
        config: input.config,
        agentDir: input.agentDir,
        requirementsToml: readCodexRequirementsToml({}),
        openClawSandboxActive: false,
        sessionPermissionMode: input.permissionMode,
        assertCurrent,
      });
      assertCurrent();
      const appServer = applyCodexSessionPermissionPolicy({
        appServer: runtimeOptions,
        pluginConfig,
        permissionMode: input.permissionMode,
        sessionRoot: input.sessionRoot,
        defaultRoot: input.workspaceDir,
        canUseAutoReview: false,
      });
      const environment = input.hostCapabilities.preparedEnvironment?.();
      const startOptions =
        appServer.start.transport === "stdio" && !isCodexAppServerProxyLaunch(appServer.start.args)
          ? {
              ...appServer.start,
              env: {
                ...appServer.start.env,
                ...environment?.credentialScrubEnv,
                ...environment?.localIdentityEnv,
                ...environment?.localProcessEnv,
              },
            }
          : appServer.start;
      const authProfileId = resolveCodexAppServerAuthProfileId({
        authProfileId: input.authProfileId ?? admitted.binding?.authProfileId,
        store: input.authProfileStore,
        config: input.config,
      });
      const client = await getLeasedSharedCodexAppServerClient({
        startOptions,
        pluginConfig: params.pluginConfig,
        agentId: input.agentId,
        agentDir: input.agentDir,
        config: input.config,
        authProfileStore: input.authProfileStore,
        authProfileId:
          admitted.binding?.connectionScope === "supervision" ||
          appServer.start.homeScope === "user"
            ? null
            : authProfileId,
        abandonSignal: input.abortSignal,
        assertCurrent,
        timeoutMs: appServer.requestTimeoutMs,
      });
      try {
        assertCurrent();
        ensureCodexAppServerClientRuntime(client, {
          agentDir: input.agentDir,
          authProfileId,
          authProfileStore: input.authProfileStore,
          config: input.config,
        });
        const pluginPolicy = resolveCodexPluginThreadConfigStartupPolicy({
          pluginConfig,
          nativeToolSurfaceEnabled: true,
        });
        const appCacheKey = buildCodexPluginAppCacheKey({
          appServer,
          agentDir: input.agentDir,
          authProfileId,
          appServerVersion: client.getServerVersion(),
          runtimeIdentity: client.getRuntimeIdentity(),
        });
        const pluginThreadConfig = pluginPolicy.pluginThreadConfigRequired
          ? createCodexPluginThreadConfigStartupProvider({
              inputFingerprint: buildCodexPluginThreadConfigInputFingerprint({
                pluginConfig: pluginPolicy.pluginThreadConfigPluginConfig,
                appCacheKey,
              }),
              enabledPluginConfigKeys: pluginPolicy.enabledPluginConfigKeys,
              policy: pluginPolicy.resolvedPluginPolicy,
              requestTimeoutMs: appServer.requestTimeoutMs,
              signal: input.abortSignal ?? new AbortController().signal,
              pluginConfig: pluginPolicy.pluginThreadConfigPluginConfig,
              client,
              configCwd: input.workspaceDir,
              appCacheKey,
            })
          : undefined;
        // Static projections use the configuration/credential owner; they do not
        // create a second MCP client to discover policy before native startup.
        const bundle = await loadCodexBundleMcpThreadConfig({
          workspaceDir: input.workspaceDir,
          agentId: input.agentId,
          cfg: input.config,
          toolOverrides: input.toolOverrides,
        });
        assertCurrent();
        const user = await buildCodexUserMcpServersThreadConfigPatchForRuntime(input.config, {
          agentId: input.agentId,
          agentDir: input.agentDir,
          toolOverrides: input.toolOverrides,
          allowLiteralOAuthProjection: appServer.connectionClass !== "remote",
        });
        assertCurrent();
        const modelSource = input.hostCapabilities.retainSourceAuthority?.();
        let nativeModelAdmission: "required" | "optional" | "disabled" | undefined;
        try {
          modelSource?.assertCurrent();
          nativeModelAdmission = modelSource
            ? modelSource.modelPolicyRequired !== false
              ? "required"
              : "optional"
            : undefined;
        } finally {
          modelSource?.release();
        }
        const bundleConfig = bundle.configPatch
          ? z.record(z.string(), z.json()).parse(bundle.configPatch)
          : undefined;
        const thread = await startOrResumeThread({
          client,
          bindingStore: params.bindingStore,
          params: { ...input, authProfileId },
          assertCurrent,
          agentId: input.agentId,
          agentDir: input.agentDir,
          cwd: input.workspaceDir,
          appServer,
          dynamicTools: [],
          nativeCodeModeEnabled: false,
          webSearchAllowed: false,
          persistentWebSearchAllowed: false,
          userMcpServersEnabled: false,
          nativeModelAdmission,
          pluginThreadConfig,
          appServerRuntimeFingerprint: buildCodexAppServerRuntimeFingerprint({
            appServer,
            appServerVersion: client.getServerVersion(),
            runtimeIdentity: client.getRuntimeIdentity(),
          }),
          config: mergeCodexThreadConfigs(bundleConfig, user),
          signal: input.abortSignal,
        });
        let retained = false;
        try {
          retained = await params.bindingStore.withLease(
            sessionBindingIdentity(input),
            async () => {
              assertCurrent();
              if (
                !isSameCodexAppServerThreadOwner(
                  params.bindingStore.read(sessionBindingIdentity(input)),
                  thread,
                )
              ) {
                return false;
              }
              thread.liveThreadOwnership?.assertCurrent();
              return await retainCodexAppServerBindingSubscription(client, thread.threadId, {
                release: thread.liveThreadOwnership?.release,
                configFingerprint: thread.liveThreadConfigFingerprint,
                serviceTier: thread.liveThreadOwnership?.serviceTier,
                ephemeralPolicy: thread.liveThreadEphemeralPolicy,
              });
            },
          );
          if (!retained) {
            throw new Error("Native MCP session ownership changed before retention");
          }
          return thread;
        } finally {
          if (!retained) {
            if (thread.liveThreadOwnership) {
              await thread.liveThreadOwnership.release(thread.threadId);
            } else {
              await rollbackCodexAppServerBindingSubscription(client, thread.threadId, false);
            }
          }
        }
      } finally {
        releaseLeasedSharedCodexAppServerClient(client);
      }
    };
    if (admitted.binding) {
      return await prepareThread();
    }
    // A cold App request owns the absent binding through subscription retention.
    // Other discoveries recheck under this same reentrant lease instead of
    // selecting a second lifecycle from an obsolete empty snapshot. Bound
    // resumes still acquire the native thread queue before the binding lease.
    const thread = await params.bindingStore.withLease(sessionBindingIdentity(input), async () => {
      assertCurrent();
      const current = params.bindingStore.read(sessionBindingIdentity(input));
      return current ?? (await prepareThread());
    });
    assertCurrent();
    return thread;
  });
}

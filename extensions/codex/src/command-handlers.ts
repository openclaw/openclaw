import type { PluginCommandContext, PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { defaultCodexAppInventoryCache } from "./app-server/app-inventory-cache.js";
import { resolveCodexAppServerAuthAccountCacheKey } from "./app-server/auth-bridge.js";
import { resolveCodexAppServerFallbackApiKeyCacheKey } from "./app-server/auth-cache-key.js";
import { resolveCodexAppServerRuntimeOptions } from "./app-server/config.js";
import { refreshCodexPluginRuntimeState } from "./app-server/plugin-activation.js";
import { buildCodexPluginAppCacheKey } from "./app-server/plugin-app-cache-key.js";
import { defaultCodexPluginMetadataCache } from "./app-server/plugin-metadata-cache.js";
import type { JsonValue, v2 } from "./app-server/protocol.js";
import {
  getLeasedSharedCodexAppServerClient,
  releaseLeasedSharedCodexAppServerClient,
} from "./app-server/shared-client.js";
import { readCodexAccountAuthOverview } from "./command-account.js";
import { refreshCodexHostedApps } from "./command-apps-refresh.js";
import {
  assertCodexHostOwnerCurrent,
  canMutateCodexHost,
  CODEX_HOST_INSPECTION_AUTH_ERROR,
  CODEX_NATIVE_EXECUTION_AUTH_ERROR,
} from "./command-authorization.js";
import { handleCodexDiagnosticsFeedback } from "./command-diagnostics.js";
import {
  buildHelp,
  formatAccount,
  formatCodexDisplayText,
  formatCodexStatus,
  formatList,
  formatModels,
  formatSkills,
} from "./command-formatters.js";
import {
  CODEX_NATIVE_CONTROL_SUBCOMMANDS,
  handleComputerUseCommand,
  handleNativeGoal,
  isReadOnlyCodexGoalCommand,
  resolveCodexNativeCommandSandboxBlock,
  returnsBeforeNativeCodexExecution,
  setConversationFastMode,
  setConversationModel,
  setConversationPermissions,
  startThreadAction,
  steerConversationTurn,
  stopConversationTurn,
} from "./command-handler-actions.js";
import {
  buildCodexComputerUseMenuReply,
  buildCodexFastMenuReply,
  buildCodexPermissionsMenuReply,
  buildCodexSubcommandPickerReply,
  isMenuVerb,
  splitArgs,
} from "./command-handler-args.js";
import {
  bindConversation,
  buildCodexCliSessions,
  buildThreads,
  describeConversationBinding,
  detachConversation,
  resumeThread,
} from "./command-handler-bindings.js";
import {
  CODEX_CONTROL_METHODS,
  resolveCodexCommandDeps,
  type CodexCommandDepsOverride,
} from "./command-handler-deps.js";
import {
  resolveCodexConversationControlScope,
  resolveCommandAppServerScope,
} from "./command-handler-scope.js";
import { handleCodexPluginsSubcommand } from "./command-plugins-management.js";
import { withCodexPluginCommandContext } from "./command-plugins-runtime.js";
import { readCodexConversationBindingData } from "./conversation-binding-data.js";

export type { CodexCommandDepsOverride } from "./command-handler-deps.js";

const CODEX_HOST_INSPECTION_SUBCOMMANDS = new Set([
  "account",
  "mcp",
  "sessions",
  "skills",
  "status",
  "threads",
]);

export async function handleCodexSubcommand(
  ctx: PluginCommandContext,
  options: { pluginConfig?: unknown; deps: CodexCommandDepsOverride },
): Promise<PluginCommandResult> {
  const deps = resolveCodexCommandDeps(options.deps);
  const args = splitArgs(ctx.args);
  if (args.length === 0) {
    return buildCodexSubcommandPickerReply();
  }
  const [subcommand = "status", ...rest] = args;
  const normalized = subcommand.toLowerCase();
  if (normalized === "help") {
    return { text: buildHelp() };
  }
  if (CODEX_HOST_INSPECTION_SUBCOMMANDS.has(normalized) && !canMutateCodexHost(ctx)) {
    return { text: CODEX_HOST_INSPECTION_AUTH_ERROR };
  }
  if (
    CODEX_NATIVE_CONTROL_SUBCOMMANDS.has(normalized) &&
    !returnsBeforeNativeCodexExecution(normalized, rest) &&
    !isReadOnlyCodexGoalCommand(normalized, rest) &&
    !canMutateCodexHost(ctx)
  ) {
    return { text: CODEX_NATIVE_EXECUTION_AUTH_ERROR };
  }
  const sandboxBlock = resolveCodexNativeCommandSandboxBlock(ctx, normalized, rest);
  if (sandboxBlock) {
    return { text: sandboxBlock };
  }
  const usageCommand = normalized === "unbind" ? "detach" : normalized;
  if (
    rest.length > 0 &&
    ["status", "models", "detach", "binding", "stop", "mcp", "skills", "account"].includes(
      usageCommand,
    )
  ) {
    return { text: `Usage: /codex ${usageCommand}` };
  }
  if (normalized === "plugins") {
    // Account-wide hosted refresh does not require plugin-management configuration IO.
    if (rest[0]?.toLowerCase() === "refresh") {
      if (rest.length !== 1) {
        return {
          text: "Usage: /codex plugins refresh — refresh hosted app inventory for the current Codex account/runtime.",
        };
      }
      if (!canMutateCodexHost(ctx)) {
        return {
          text: "Only an owner or operator.admin gateway client can refresh hosted app inventory.",
        };
      }
      return await withCodexPluginCommandContext(
        { deps, ctx, pluginConfig: options.pluginConfig },
        (context) => refreshCodexHostedApps(context),
      );
    }
    if (!deps.codexPluginsManagementIo) {
      return {
        text:
          "Codex sub-plugin management is not wired up (codexPluginsManagementIo dep is undefined). " +
          "Edit ~/.openclaw/openclaw.json or use `openclaw config patch` until the runtime exposes the IO.",
      };
    }
    let appServerScope: ReturnType<typeof resolveCommandAppServerScope> | undefined;
    const getAppServerScope = () =>
      (appServerScope ??= resolveCommandAppServerScope(deps, ctx, options.pluginConfig));
    return await handleCodexPluginsSubcommand(ctx, rest, deps.codexPluginsManagementIo, {
      withContext: (run) =>
        withCodexPluginCommandContext({ deps, ctx, pluginConfig: options.pluginConfig }, run),
      workspaceDir: async () => {
        const data = readCodexConversationBindingData(await ctx.getCurrentConversationBinding());
        const workspaceDir =
          data?.kind === "codex-app-server-session" ? data.workspaceDir : undefined;
        return workspaceDir?.trim() || deps.resolveCodexDefaultWorkspaceDir(options.pluginConfig);
      },
      list: async (requestParams) => {
        const scope = await getAppServerScope();
        return (await deps.codexControlRequest(
          options.pluginConfig,
          CODEX_CONTROL_METHODS.listPlugins,
          requestParams,
          { ...scope, config: ctx.config },
        )) as v2.PluginListResponse;
      },
      install: async (requestParams) => {
        const scope = await getAppServerScope();
        return (await deps.codexControlRequest(
          options.pluginConfig,
          CODEX_CONTROL_METHODS.installPlugin,
          requestParams,
          {
            ...scope,
            config: ctx.config,
            assertOwnerCurrent: () => assertCodexHostOwnerCurrent(ctx),
          },
        )) as v2.PluginInstallResponse;
      },
      refresh: async (workspaceDir) => {
        const scope = await getAppServerScope();
        const configuredAppServer = resolveCodexAppServerRuntimeOptions({
          pluginConfig: options.pluginConfig,
        });
        const appServer = scope.startOptions
          ? { ...configuredAppServer, start: scope.startOptions }
          : configuredAppServer;
        const authProfileId = scope.authProfileId ?? undefined;
        const accountId = await resolveCodexAppServerAuthAccountCacheKey({
          authProfileId,
          agentDir: scope.agentDir,
          config: ctx.config,
        });
        const client = await getLeasedSharedCodexAppServerClient({
          startOptions: appServer.start,
          pluginConfig: options.pluginConfig,
          authProfileId: scope.authProfileId,
          agentDir: scope.agentDir,
          config: ctx.config,
        });
        try {
          const appCacheKey = buildCodexPluginAppCacheKey({
            appServer,
            agentDir: scope.agentDir,
            authProfileId,
            accountId,
            envApiKeyFingerprint: authProfileId
              ? undefined
              : resolveCodexAppServerFallbackApiKeyCacheKey({ startOptions: appServer.start }),
            appServerVersion: client.getServerVersion(),
            runtimeIdentity: client.getRuntimeIdentity(),
          });
          return await refreshCodexPluginRuntimeState({
            configCwd: workspaceDir,
            appCache: defaultCodexAppInventoryCache,
            appCacheKey,
            metadataCache: defaultCodexPluginMetadataCache,
            request: async (method, requestParams) => {
              const requestMethod = resolvePluginRuntimeRefreshMethod(method);
              return await deps.codexControlRequest(
                options.pluginConfig,
                requestMethod,
                requestParams as JsonValue | undefined,
                { ...scope, config: ctx.config },
              );
            },
          });
        } finally {
          releaseLeasedSharedCodexAppServerClient(client);
        }
      },
    });
  }
  if (normalized === "status") {
    const { agentDir } = resolveCodexConversationControlScope(ctx);
    return {
      text: formatCodexStatus(
        await deps.readCodexStatusProbes(options.pluginConfig, ctx.config, agentDir),
      ),
    };
  }
  if (normalized === "models") {
    const { agentDir } = resolveCodexConversationControlScope(ctx);
    return {
      text: formatModels(
        await deps.listCodexAppServerModels(
          deps.requestOptions(options.pluginConfig, 100, ctx.config, agentDir),
        ),
      ),
    };
  }
  if (normalized === "threads") {
    return { text: await buildThreads(deps, ctx, options.pluginConfig, rest.join(" ")) };
  }
  if (normalized === "goal") {
    return { text: await handleNativeGoal(deps, ctx, options.pluginConfig, rest) };
  }
  if (normalized === "sessions") {
    return { text: await buildCodexCliSessions(deps, rest) };
  }
  if (normalized === "resume") {
    return { text: await resumeThread(deps, ctx, options.pluginConfig, rest) };
  }
  if (normalized === "bind") {
    return await bindConversation(deps, ctx, options.pluginConfig, rest);
  }
  if (normalized === "detach" || normalized === "unbind") {
    return { text: await detachConversation(deps, ctx) };
  }
  if (normalized === "binding") {
    return { text: await describeConversationBinding(deps, ctx) };
  }
  if (normalized === "stop") {
    return { text: await stopConversationTurn(deps, ctx) };
  }
  if (normalized === "steer") {
    return {
      text: await steerConversationTurn(deps, ctx, rest.join(" ")),
    };
  }
  if (normalized === "model") {
    return { text: await setConversationModel(deps, ctx, options.pluginConfig, rest) };
  }
  if (normalized === "fast") {
    if (isMenuVerb(rest)) {
      return buildCodexFastMenuReply();
    }
    return { text: await setConversationFastMode(deps, ctx, rest) };
  }
  if (normalized === "permissions") {
    if (isMenuVerb(rest)) {
      return buildCodexPermissionsMenuReply();
    }
    return { text: await setConversationPermissions(deps, ctx, rest) };
  }
  if (normalized === "compact" || normalized === "review") {
    return { text: await startThreadAction(deps, ctx, options.pluginConfig, normalized, rest) };
  }
  if (normalized === "diagnostics") {
    return await handleCodexDiagnosticsFeedback(
      deps,
      ctx,
      options.pluginConfig,
      rest.join(" "),
      "/codex diagnostics",
    );
  }
  if (normalized === "computer-use" || normalized === "computeruse") {
    if (isMenuVerb(rest)) {
      return buildCodexComputerUseMenuReply();
    }
    return {
      text: await handleComputerUseCommand(deps, ctx, options.pluginConfig, rest),
    };
  }
  if (normalized === "mcp" || normalized === "skills") {
    const scope = await resolveCommandAppServerScope(deps, ctx, options.pluginConfig);
    const response = await deps.codexControlRequest(
      options.pluginConfig,
      normalized === "mcp"
        ? CODEX_CONTROL_METHODS.listMcpServers
        : CODEX_CONTROL_METHODS.listSkills,
      normalized === "mcp" ? { limit: 100 } : {},
      { config: ctx.config, ...scope },
    );
    return {
      text: normalized === "mcp" ? formatList(response, "MCP servers") : formatSkills(response),
    };
  }
  if (normalized === "account") {
    const scope = await resolveCommandAppServerScope(deps, ctx, options.pluginConfig);
    const requestScope = { config: ctx.config, ...scope };
    const [account, limits] = await Promise.all([
      deps.safeCodexControlRequest(
        options.pluginConfig,
        CODEX_CONTROL_METHODS.account,
        { refreshToken: false },
        requestScope,
      ),
      deps.safeCodexControlRequest(
        options.pluginConfig,
        CODEX_CONTROL_METHODS.rateLimits,
        undefined,
        requestScope,
      ),
    ]);
    return {
      text: formatAccount(
        account,
        limits,
        await readCodexAccountAuthOverview({
          ctx,
          agentDir: scope.agentDir,
          authProfileId: scope.authProfileId,
          pluginConfig: options.pluginConfig,
          safeCodexControlRequest: deps.safeCodexControlRequest,
          account,
          limits,
        }),
      ),
    };
  }
  return { text: `Unknown Codex command: ${formatCodexDisplayText(subcommand)}\n\n${buildHelp()}` };
}

function resolvePluginRuntimeRefreshMethod(method: string) {
  const supported = [
    CODEX_CONTROL_METHODS.listPlugins,
    CODEX_CONTROL_METHODS.installedApps,
    CODEX_CONTROL_METHODS.readApps,
  ] as const;
  const recognized = supported.find((candidate) => candidate === method);
  if (!recognized) {
    throw new Error(`Unexpected Codex plugin refresh method: ${method}`);
  }
  return recognized;
}

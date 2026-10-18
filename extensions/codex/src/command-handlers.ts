import type { PluginCommandResult } from "openclaw/plugin-sdk/plugin-entry";
import { defaultCodexAppInventoryCache } from "./app-server/app-inventory-cache.js";
import { CODEX_CONTROL_METHODS } from "./app-server/capabilities.js";
import { readCodexPluginConfig } from "./app-server/config-parsing.js";
import { listAllCodexAppServerModels } from "./app-server/models.js";
import { refreshCodexPluginRuntimeState } from "./app-server/plugin-activation.js";
import { defaultCodexPluginMetadataCache } from "./app-server/plugin-metadata-cache.js";
import { readCodexAccountAuthOverview } from "./command-account.js";
import { refreshCodexHostedApps } from "./command-apps-refresh.js";
import {
  assertCodexHostOwnerCurrent,
  canMutateCodexHost,
  CODEX_HOST_INSPECTION_AUTH_ERROR,
  CODEX_NATIVE_EXECUTION_AUTH_ERROR,
  type CodexCommandContext,
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
  controlConversationTurn,
  handleComputerUseCommand,
  handleNativeGoal,
  isReadOnlyCodexGoalCommand,
  resolveCodexNativeCommandSandboxBlock,
  returnsBeforeNativeCodexExecution,
  setConversationModel,
  setConversationPreference,
  startThreadAction,
} from "./command-handler-actions.js";
import {
  buildCodexChoiceMenuReply,
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
import type { CodexCommandDeps } from "./command-handler-deps.js";
import {
  resolveCodexConversationControlScope,
  resolveCommandAppServerScope,
} from "./command-handler-scope.js";
import { handleCodexPluginsSubcommand } from "./command-plugins-management.js";
import { withCodexPluginCommandContext } from "./command-plugins-runtime.js";
import {
  codexControlRequest,
  readCodexStatusProbes,
  requestOptions,
  safeCodexControlRequest,
} from "./command-rpc.js";
import {
  readCodexConversationBindingData,
  resolveCodexDefaultWorkspaceDir,
} from "./conversation-binding-data.js";

const CODEX_HOST_INSPECTION_SUBCOMMANDS = new Set([
  "account",
  "mcp",
  "sessions",
  "skills",
  "status",
  "threads",
]);

export async function handleCodexSubcommand(
  inputCtx: CodexCommandContext,
  options: { pluginConfig?: unknown; deps: CodexCommandDeps },
): Promise<PluginCommandResult> {
  const { deps } = options;
  const args = splitArgs(inputCtx.args);
  if (args.length === 0) {
    return buildCodexSubcommandPickerReply();
  }
  const [subcommand = "status", ...rest] = args;
  const normalized = subcommand.toLowerCase();
  if (normalized === "help") {
    return { text: buildHelp() };
  }
  if (CODEX_HOST_INSPECTION_SUBCOMMANDS.has(normalized) && !canMutateCodexHost(inputCtx)) {
    return { text: CODEX_HOST_INSPECTION_AUTH_ERROR };
  }
  if (
    CODEX_NATIVE_CONTROL_SUBCOMMANDS.has(normalized) &&
    !returnsBeforeNativeCodexExecution(normalized, rest) &&
    !isReadOnlyCodexGoalCommand(normalized, rest) &&
    !canMutateCodexHost(inputCtx)
  ) {
    return { text: CODEX_NATIVE_EXECUTION_AUTH_ERROR };
  }
  const nativePolicy = await resolveCodexNativeCommandSandboxBlock(inputCtx, normalized, rest);
  try {
    if (nativePolicy.block) {
      return { text: nativePolicy.block };
    }
    const previousPolicyCheck = inputCtx.assertNativePolicyCurrent;
    const ctx = {
      ...inputCtx,
      nativePolicySource: nativePolicy.source,
      assertNativePolicyCurrent: async () => {
        await previousPolicyCheck?.();
        await nativePolicy.assertCurrent();
      },
    };
    const usageCommand = normalized === "unbind" ? "detach" : normalized;
    if (
      rest.length > 0 &&
      ["status", "models", "detach", "binding", "stop", "mcp", "skills", "account"].includes(
        usageCommand,
      )
    ) {
      return { text: `Usage: /codex ${usageCommand}` };
    }
    const pluginConfig = readCodexPluginConfig(options.pluginConfig);
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
        return await withCodexPluginCommandContext({ deps, ctx, pluginConfig }, (context) =>
          refreshCodexHostedApps(context),
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
      await using _ = {
        [Symbol.asyncDispose]: async () => {
          await appServerScope?.then(
            (scope) => scope.release(),
            () => {},
          );
        },
      };
      const getAppServerScope = () =>
        (appServerScope ??= resolveCommandAppServerScope(deps, ctx, pluginConfig));
      return await handleCodexPluginsSubcommand(ctx, rest, deps.codexPluginsManagementIo, {
        withContext: (run) => withCodexPluginCommandContext({ deps, ctx, pluginConfig }, run),
        workspaceDir: async () => {
          const data = readCodexConversationBindingData(await ctx.getCurrentConversationBinding());
          const workspaceDir =
            data?.kind === "codex-app-server-session" ? data.workspaceDir : undefined;
          return workspaceDir?.trim() || resolveCodexDefaultWorkspaceDir(pluginConfig);
        },
        list: async (requestParams) => {
          const scope = await getAppServerScope();
          return await codexControlRequest(
            pluginConfig,
            CODEX_CONTROL_METHODS.listPlugins,
            requestParams,
            { ...scope, config: ctx.config },
          );
        },
        install: async (requestParams) => {
          const scope = await getAppServerScope();
          return await codexControlRequest(
            pluginConfig,
            CODEX_CONTROL_METHODS.installPlugin,
            requestParams,
            {
              ...scope,
              config: ctx.config,
              assertOwnerCurrent: () => assertCodexHostOwnerCurrent(ctx),
            },
          );
        },
        refresh: (workspaceDir) =>
          withCodexPluginCommandContext({ deps, ctx, pluginConfig }, (context) =>
            refreshCodexPluginRuntimeState({
              configCwd: workspaceDir,
              appCache: defaultCodexAppInventoryCache,
              appCacheKey: context.appCacheKey,
              metadataCache: defaultCodexPluginMetadataCache,
              request: context.request,
            }),
          ),
      });
    }
    if (normalized === "status") {
      const { agentDir } = resolveCodexConversationControlScope(ctx);
      return {
        text: formatCodexStatus(await readCodexStatusProbes(pluginConfig, ctx.config, agentDir)),
      };
    }
    if (normalized === "models") {
      const { agentDir } = resolveCodexConversationControlScope(ctx);
      return {
        text: formatModels(
          await listAllCodexAppServerModels(
            requestOptions(pluginConfig, 100, ctx.config, agentDir),
          ),
        ),
      };
    }
    if (normalized === "threads") {
      return { text: await buildThreads(deps, ctx, pluginConfig, rest.join(" ")) };
    }
    if (normalized === "goal") {
      return { text: await handleNativeGoal(deps, ctx, pluginConfig, rest) };
    }
    if (normalized === "sessions") {
      return { text: await buildCodexCliSessions(deps, rest) };
    }
    if (normalized === "resume") {
      return { text: await resumeThread(deps, ctx, pluginConfig, rest) };
    }
    if (normalized === "bind") {
      return await bindConversation(deps, ctx, pluginConfig, rest);
    }
    if (normalized === "detach" || normalized === "unbind") {
      return { text: await detachConversation(deps, ctx) };
    }
    if (normalized === "binding") {
      return { text: await describeConversationBinding(deps, ctx) };
    }
    if (normalized === "stop" || normalized === "steer") {
      return { text: await controlConversationTurn(deps, ctx, normalized, rest.join(" ")) };
    }
    if (normalized === "model") {
      return { text: await setConversationModel(deps, ctx, rest) };
    }
    if (normalized === "fast" || normalized === "permissions") {
      if (isMenuVerb(rest)) {
        return buildCodexChoiceMenuReply(normalized);
      }
      return { text: await setConversationPreference(deps, ctx, rest, normalized) };
    }
    if (normalized === "compact" || normalized === "review") {
      return { text: await startThreadAction(deps, ctx, pluginConfig, normalized, rest) };
    }
    if (normalized === "diagnostics") {
      return await handleCodexDiagnosticsFeedback(deps, ctx, pluginConfig, rest.join(" "));
    }
    if (normalized === "computer-use" || normalized === "computeruse") {
      if (isMenuVerb(rest)) {
        return buildCodexChoiceMenuReply("computer-use");
      }
      return {
        text: await handleComputerUseCommand(ctx, pluginConfig, rest),
      };
    }
    if (normalized === "mcp" || normalized === "skills") {
      const scope = await resolveCommandAppServerScope(deps, ctx, pluginConfig);
      using _ = { [Symbol.dispose]: scope.release };
      const response = await codexControlRequest(
        pluginConfig,
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
      const scope = await resolveCommandAppServerScope(deps, ctx, pluginConfig);
      using _ = { [Symbol.dispose]: scope.release };
      const requestScope = { config: ctx.config, ...scope };
      const [account, limits] = await Promise.all([
        safeCodexControlRequest(
          pluginConfig,
          CODEX_CONTROL_METHODS.account,
          { refreshToken: false },
          requestScope,
        ),
        safeCodexControlRequest(
          pluginConfig,
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
            pluginConfig,
            account,
            limits,
          }),
        ),
      };
    }
    return {
      text: `Unknown Codex command: ${formatCodexDisplayText(subcommand)}\n\n${buildHelp()}`,
    };
  } finally {
    nativePolicy.release();
  }
}

// Discord plugin module implements native command model picker apply behavior.
import { randomUUID } from "node:crypto";
import type { ChatCommandDefinition, CommandArgs } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  applyModelOverrideToSessionEntry,
  ModelSelectionLockedError,
} from "openclaw/plugin-sdk/model-session-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  getSessionEntry,
  patchSessionEntry,
  resolveStorePath,
  type SessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import type { ButtonInteraction, StringSelectMenuInteraction } from "../internal/discord.js";
import {
  recordDiscordModelPickerRecentModel,
  type DiscordModelPickerPreferenceScope,
} from "./model-picker-preferences.js";
import type { DispatchDiscordCommandInteraction } from "./native-command-dispatch.js";
import type { DiscordModelPickerSessionBinding } from "./native-command-model-picker-authorization.js";
import type { ThreadBindingManager } from "./thread-bindings.js";

type DiscordConfig = NonNullable<OpenClawConfig["channels"]>["discord"];

type DiscordModelPickerSelectionCommand = {
  prompt: string;
  command: ChatCommandDefinition;
  args?: CommandArgs;
  authorizationValues: Record<string, string>;
};

type DiscordModelPickerMutationAuthorization =
  | { allowed: true }
  | { allowed: false; noticeMessage: string };

type DiscordModelPickerApplyResult =
  | { status: "success"; effectiveModelRef: string; noticeMessage: string }
  | { status: "mismatch"; effectiveModelRef: string; noticeMessage: string }
  | { status: "rejected"; noticeMessage: string }
  | { status: "timeout"; noticeMessage: string }
  | { status: "failed"; noticeMessage: string };

type DiscordModelPickerPersistResult =
  | { status: "current"; changed: boolean }
  | { status: "stale" };

function normalizeExpectedRuntime(runtime: string | undefined): string | undefined {
  const normalized = runtime?.trim();
  if (!normalized) {
    return undefined;
  }
  return normalized === "default" ? "auto" : normalized;
}

function matchesExpectedRuntime(params: {
  expectedRuntime?: string;
  currentRuntime: string;
}): boolean {
  if (!params.expectedRuntime) {
    return true;
  }
  const currentRuntime = params.currentRuntime.trim() || "auto";
  return currentRuntime === params.expectedRuntime;
}

function resolveDiscordModelPickerSessionBinding(params: {
  cfg: OpenClawConfig;
  route: ResolvedAgentRoute;
}): DiscordModelPickerSessionBinding {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.route.agentId,
  });
  const entry = getSessionEntry({
    storePath,
    sessionKey: params.route.sessionKey,
    readConsistency: "latest",
  });
  return entry ? { sessionId: entry.sessionId, updatedAt: entry.updatedAt } : null;
}

function matchesDiscordModelPickerSessionBinding(params: {
  entry: SessionEntry | undefined;
  expected: DiscordModelPickerSessionBinding;
}): boolean {
  if (params.expected === null) {
    return params.entry === undefined;
  }
  return (
    params.entry?.sessionId === params.expected.sessionId &&
    params.entry.updatedAt === params.expected.updatedAt
  );
}

function matchesDiscordModelPickerAuthorizationValues(params: {
  actual: Readonly<Record<string, string>> | undefined;
  expected: Readonly<Record<string, string>>;
}): boolean {
  if (!params.actual) {
    return false;
  }
  const expectedEntries = Object.entries(params.expected);
  return (
    Object.keys(params.actual).length === expectedEntries.length &&
    expectedEntries.every(([key, value]) => params.actual[key] === value)
  );
}

async function persistDiscordModelPickerOverride(params: {
  cfg: OpenClawConfig;
  route: ResolvedAgentRoute;
  provider: string;
  model: string;
  isDefault: boolean;
  runtime?: string;
  expectedSessionBinding: DiscordModelPickerSessionBinding;
}): Promise<DiscordModelPickerPersistResult> {
  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.route.agentId,
  });
  let checkedCurrentEntry = false;
  let stale = false;
  let persisted = false;
  // Policy runs before the store lock. Recheck session identity and version in the writer so a
  // reset or concurrent mutation cannot inherit the earlier decision.
  await patchSessionEntry({
    storePath,
    sessionKey: params.route.sessionKey,
    ...(params.expectedSessionBinding === null
      ? {
          fallbackEntry: {
            sessionId: randomUUID(),
            updatedAt: Date.now(),
          },
        }
      : {}),
    replaceEntry: true,
    update: (entry, context) => {
      checkedCurrentEntry = true;
      if (
        !matchesDiscordModelPickerSessionBinding({
          entry: context.existingEntry,
          expected: params.expectedSessionBinding,
        })
      ) {
        stale = true;
        return null;
      }
      persisted =
        applyModelOverrideToSessionEntry({
          entry,
          selection: {
            provider: params.provider,
            model: params.model,
            isDefault: params.isDefault,
          },
          markLiveSwitchPending: true,
        }).updated || persisted;
      const runtime = params.runtime?.trim();
      if (runtime && runtime !== "auto" && runtime !== "default") {
        if (entry.agentRuntimeOverride !== runtime) {
          entry.agentRuntimeOverride = runtime;
          delete entry.agentHarnessId;
          persisted = true;
        }
      } else if (runtime && entry.agentRuntimeOverride) {
        delete entry.agentRuntimeOverride;
        delete entry.agentHarnessId;
        persisted = true;
      }
      if (persisted) {
        entry.updatedAt = Math.max(Date.now(), entry.updatedAt + 1);
      }
      return entry;
    },
  });
  return !checkedCurrentEntry || stale
    ? { status: "stale" }
    : { status: "current", changed: persisted };
}

export async function applyDiscordModelPickerSelection(params: {
  interaction: ButtonInteraction | StringSelectMenuInteraction;
  selectionCommand: DiscordModelPickerSelectionCommand;
  dispatchCommandInteraction: DispatchDiscordCommandInteraction;
  cfg: OpenClawConfig;
  discordConfig: DiscordConfig;
  accountId: string;
  sessionPrefix: string;
  threadBindings: ThreadBindingManager;
  route: ResolvedAgentRoute;
  resolvedModelRef: string;
  selectedProvider: string;
  selectedModel: string;
  selectedRuntime?: string;
  defaultProvider: string;
  defaultModel: string;
  preferenceScope: DiscordModelPickerPreferenceScope;
  settleMs: number;
  resolveCurrentModel: (route: ResolvedAgentRoute) => string;
  resolveCurrentRuntime: (route: ResolvedAgentRoute) => string;
  authorizeDirectPersist: (
    route: ResolvedAgentRoute,
    sessionBinding: DiscordModelPickerSessionBinding,
  ) => Promise<DiscordModelPickerMutationAuthorization>;
}): Promise<DiscordModelPickerApplyResult> {
  try {
    const dispatchResult = await withTimeout(
      params.dispatchCommandInteraction({
        interaction: params.interaction,
        prompt: params.selectionCommand.prompt,
        command: params.selectionCommand.command,
        commandArgs: params.selectionCommand.args,
        cfg: params.cfg,
        discordConfig: params.discordConfig,
        accountId: params.accountId,
        sessionPrefix: params.sessionPrefix,
        preferFollowUp: true,
        threadBindings: params.threadBindings,
        suppressReplies: true,
        expectedRoute: {
          agentId: params.route.agentId,
          sessionKey: params.route.sessionKey,
        },
        requireCoreCommandAuthorization: true,
        commandAuthorizationValues: params.selectionCommand.authorizationValues,
      }),
      12000,
    );
    if (!dispatchResult.accepted) {
      return {
        status: "rejected",
        noticeMessage:
          dispatchResult.rejection === "authorization-denied"
            ? "❌ Command blocked by authorization policy."
            : dispatchResult.rejection === "route-mismatch"
              ? "❌ Model change authorization did not match this session."
              : `❌ Failed to apply ${params.resolvedModelRef}. Try /model ${params.resolvedModelRef} directly.`,
      };
    }
    const authorizationRoute = dispatchResult.coreCommandAuthorization;
    const fallbackRoute = dispatchResult.effectiveRoute ?? params.route;
    const expectedRawArguments = params.selectionCommand.args?.raw;
    if (
      !authorizationRoute ||
      authorizationRoute.agentId !== params.route.agentId ||
      authorizationRoute.sessionKey !== params.route.sessionKey ||
      authorizationRoute.commandName !== params.selectionCommand.command.key ||
      authorizationRoute.rawArguments !== expectedRawArguments ||
      !matchesDiscordModelPickerAuthorizationValues({
        actual: authorizationRoute.values,
        expected: params.selectionCommand.authorizationValues,
      }) ||
      fallbackRoute.agentId !== authorizationRoute.agentId ||
      fallbackRoute.sessionKey !== authorizationRoute.sessionKey
    ) {
      return {
        status: "rejected",
        noticeMessage: "❌ Model change authorization did not match this session.",
      };
    }

    if (params.settleMs > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, params.settleMs);
      });
    }

    const expectedRuntime = normalizeExpectedRuntime(params.selectedRuntime);
    let effectiveModelRef = params.resolveCurrentModel(fallbackRoute);
    let effectiveRuntime = params.resolveCurrentRuntime(fallbackRoute);
    let persisted =
      effectiveModelRef === params.resolvedModelRef &&
      matchesExpectedRuntime({ expectedRuntime, currentRuntime: effectiveRuntime });

    if (!persisted) {
      logVerbose(
        `discord: model picker override mismatch — expected ${params.resolvedModelRef}${expectedRuntime ? ` with runtime ${expectedRuntime}` : ""} but read ${effectiveModelRef} with runtime ${effectiveRuntime} from session key ${fallbackRoute.sessionKey}; attempting direct session override persist`,
      );
      const sessionBinding = resolveDiscordModelPickerSessionBinding({
        cfg: params.cfg,
        route: fallbackRoute,
      });
      const directPersistAuthorization = await params.authorizeDirectPersist(
        fallbackRoute,
        sessionBinding,
      );
      if (!directPersistAuthorization.allowed) {
        return {
          status: "rejected",
          noticeMessage: directPersistAuthorization.noticeMessage,
        };
      }
      try {
        const directPersistResult = await persistDiscordModelPickerOverride({
          cfg: params.cfg,
          route: fallbackRoute,
          provider: params.selectedProvider,
          model: params.selectedModel,
          isDefault:
            params.selectedProvider === params.defaultProvider &&
            params.selectedModel === params.defaultModel,
          runtime: params.selectedRuntime,
          expectedSessionBinding: sessionBinding,
        });
        if (directPersistResult.status === "stale") {
          return {
            status: "rejected",
            noticeMessage: "❌ Model change authorization expired because this session changed.",
          };
        }
        await new Promise((resolve) => {
          setTimeout(resolve, 100);
        });
        effectiveModelRef = params.resolveCurrentModel(fallbackRoute);
        effectiveRuntime = params.resolveCurrentRuntime(fallbackRoute);
        persisted =
          effectiveModelRef === params.resolvedModelRef &&
          matchesExpectedRuntime({ expectedRuntime, currentRuntime: effectiveRuntime });
        if (!persisted) {
          logVerbose(
            `discord: direct session override persist failed — expected ${params.resolvedModelRef}${expectedRuntime ? ` with runtime ${expectedRuntime}` : ""} but read ${effectiveModelRef} with runtime ${effectiveRuntime} from session key ${fallbackRoute.sessionKey}`,
          );
        } else if (!directPersistResult.changed) {
          logVerbose(
            `discord: direct session override persist became a no-op because ${params.resolvedModelRef} was already present on re-read for session key ${fallbackRoute.sessionKey}`,
          );
        }
      } catch (error) {
        if (error instanceof ModelSelectionLockedError) {
          return {
            status: "rejected",
            noticeMessage: `❌ ${error.message}`,
          };
        }
        const message = error instanceof Error ? error.message : String(error);
        logVerbose(
          `discord: direct session override persist threw for session key ${fallbackRoute.sessionKey}: ${message}`,
        );
      }
    }

    if (persisted) {
      await recordDiscordModelPickerRecentModel({
        scope: params.preferenceScope,
        modelRef: params.resolvedModelRef,
        limit: 5,
      }).catch(() => undefined);
    }

    return persisted
      ? {
          status: "success",
          effectiveModelRef,
          noticeMessage: `✅ Model set to ${params.resolvedModelRef}${expectedRuntime ? ` with runtime ${expectedRuntime}` : ""}.`,
        }
      : {
          status: "mismatch",
          effectiveModelRef,
          noticeMessage: `⚠️ Tried to set ${params.resolvedModelRef}${expectedRuntime ? ` with runtime ${expectedRuntime}` : ""}, but current selection is ${effectiveModelRef} with runtime ${effectiveRuntime}.`,
        };
  } catch (error) {
    if (error instanceof ModelSelectionLockedError) {
      return {
        status: "rejected",
        noticeMessage: `❌ ${error.message}`,
      };
    }
    if (error instanceof Error && error.message === "timeout") {
      return {
        status: "timeout",
        noticeMessage: `⏳ Model change to ${params.resolvedModelRef} is still processing. Check /status in a few seconds.`,
      };
    }
    return {
      status: "failed",
      noticeMessage: `❌ Failed to apply ${params.resolvedModelRef}. Try /model ${params.resolvedModelRef} directly.`,
    };
  }
}

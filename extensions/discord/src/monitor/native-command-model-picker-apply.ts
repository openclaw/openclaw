import type { ChatCommandDefinition, CommandArgs } from "openclaw/plugin-sdk/command-auth-native";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import type { ButtonInteraction, StringSelectMenuInteraction } from "../internal/discord.js";
import {
  recordDiscordModelPickerRecentModel,
  type DiscordModelPickerPreferenceScope,
} from "./model-picker-preferences.js";
import type { DispatchDiscordCommandInteraction } from "./native-command-dispatch.js";
import type { DiscordCommandArgContext } from "./native-command-ui.types.js";

type DiscordModelPickerSelectionCommand = {
  prompt: string;
  command: ChatCommandDefinition;
  args?: CommandArgs;
};

type DiscordModelPickerApplyResult =
  | { status: "success" | "mismatch"; effectiveModelRef: string; noticeMessage: string }
  | { status: "rejected" | "timeout" | "failed"; noticeMessage: string };

export async function applyDiscordModelPickerSelection(
  params: DiscordCommandArgContext & {
    interaction: ButtonInteraction | StringSelectMenuInteraction;
    selectionCommand: DiscordModelPickerSelectionCommand;
    dispatchCommandInteraction: DispatchDiscordCommandInteraction;
    route: ResolvedAgentRoute;
    resolvedModelRef: string;
    selectedRuntime?: string;
    preferenceScope: DiscordModelPickerPreferenceScope;
    settleMs: number;
    resolveCurrentModel: (route: ResolvedAgentRoute) => string;
    resolveCurrentRuntime: (route: ResolvedAgentRoute) => string;
  },
): Promise<DiscordModelPickerApplyResult> {
  const failureNotice = `❌ Failed to apply ${params.resolvedModelRef}. Try /model ${params.resolvedModelRef} directly.`;
  try {
    const dispatchResult = await withTimeout(
      params.dispatchCommandInteraction({
        readPolicy: params.readPolicy,
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
        buildContext: params.buildContext,
        dispatchReplyFromConfig: params.dispatchReplyFromConfig,
        pluginCommandDispatch: { kind: "non-plugin" },
      }),
      12000,
    );
    if (!dispatchResult.accepted) {
      return { status: "rejected", noticeMessage: failureNotice };
    }
    const hiddenFinalReply = dispatchResult.hiddenFinalReply;
    const effectiveRoute = dispatchResult.effectiveRoute ?? params.route;
    if (params.settleMs > 0) {
      await new Promise((resolve) => {
        setTimeout(resolve, params.settleMs);
      });
    }

    const effectiveModelRef = params.resolveCurrentModel(effectiveRoute);
    const effectiveRuntime = params.resolveCurrentRuntime(effectiveRoute);
    const currentSelection = `Current selection: ${effectiveModelRef} with runtime ${effectiveRuntime}.`;
    if (hiddenFinalReply?.isError) {
      return {
        status: "rejected",
        noticeMessage: `${hiddenFinalReply.text?.trim()}\n${currentSelection}`,
      };
    }
    const selectedRuntime = params.selectedRuntime?.trim();
    const expectedRuntime =
      selectedRuntime === "auto" || selectedRuntime === "default"
        ? "auto"
        : selectedRuntime || undefined;
    const verified =
      effectiveModelRef === params.resolvedModelRef &&
      (expectedRuntime === undefined || effectiveRuntime === expectedRuntime);
    if (verified) {
      await recordDiscordModelPickerRecentModel({
        scope: params.preferenceScope,
        modelRef: params.resolvedModelRef,
        limit: 5,
      }).catch(() => undefined);
    }

    return {
      status: verified ? "success" : "mismatch",
      effectiveModelRef,
      noticeMessage: verified
        ? hiddenFinalReply?.text?.trim() || `✅ Model set to ${params.resolvedModelRef}.`
        : `⚠️ Tried to set ${params.resolvedModelRef}${expectedRuntime ? ` with runtime ${expectedRuntime}` : ""}, but current selection is ${effectiveModelRef} with runtime ${effectiveRuntime}.`,
    };
  } catch (error) {
    if (error instanceof Error && error.message === "timeout") {
      return {
        status: "timeout",
        noticeMessage: `⏳ Model change to ${params.resolvedModelRef} is still processing. Check /status in a few seconds.`,
      };
    }
    return { status: "failed", noticeMessage: failureNotice };
  }
}

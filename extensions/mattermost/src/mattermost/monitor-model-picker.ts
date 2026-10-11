import { getSessionEntryAsync, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { recordDeliveredCommandExchange } from "openclaw/plugin-sdk/session-transcript-runtime";
import { runDetachedWebhookWork } from "openclaw/plugin-sdk/webhook-request-guards";
import type { MattermostPost } from "./client.js";
import type {
  MattermostInteractiveButtonInput,
  MattermostInteractionResponse,
} from "./interactions.js";
import {
  buildMattermostAllowedModelRefs,
  parseMattermostModelPickerContext,
  renderMattermostModelsPickerView,
  renderMattermostProviderPickerView,
  resolveMattermostModelPickerCurrentModel,
} from "./model-picker.js";
import { authorizeMattermostCommandInvocation } from "./monitor-auth.js";
import { buildMattermostModelPickerSelectMessageSid } from "./monitor-context.js";
import { buildMattermostEventPlan } from "./monitor-event-plan.js";
import { dispatchMattermostInteractionReply } from "./monitor-interaction-dispatch.js";
import type { MattermostMonitorContext } from "./monitor-types.js";
import { buildPreparedModelsProviderData } from "./runtime-api.js";

export type MattermostModelPickerInteractionHandler = (params: {
  payload: {
    channel_id: string;
    post_id: string;
    team_id?: string;
    user_id: string;
  };
  userName: string;
  context: Record<string, unknown>;
  post: MattermostPost;
}) => Promise<MattermostInteractionResponse | null>;

export function createMattermostModelPickerInteractionHandler(
  monitor: MattermostMonitorContext,
): MattermostModelPickerInteractionHandler {
  const { account, cfg, core, pairing, resources, runtime } = monitor;
  const { resolveChannelInfo, updateModelPickerPost } = resources;

  return async (params) => {
    const pickerState = parseMattermostModelPickerContext(params.context);
    if (!pickerState) {
      return null;
    }
    if (pickerState.ownerUserId !== params.payload.user_id) {
      return { ephemeral_text: "Only the person who opened this picker can use it." };
    }
    const channelInfo = await resolveChannelInfo(params.payload.channel_id);
    const pickerCommandText =
      pickerState.action === "select"
        ? `/model ${pickerState.provider}/${pickerState.model}`
        : pickerState.action === "list"
          ? `/models ${pickerState.provider}`
          : "/models";
    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg,
      surface: "mattermost",
    });
    const auth = await authorizeMattermostCommandInvocation({
      account,
      cfg,
      senderId: params.payload.user_id,
      senderName: params.userName,
      channelId: params.payload.channel_id,
      channelInfo,
      readStoreAllowFrom: pairing.readAllowFromStore,
      allowTextCommands,
      hasControlCommand: core.channel.text.hasControlCommand(pickerCommandText, cfg),
    });
    if (!auth.ok) {
      if (auth.denyReason === "dm-pairing") {
        const { code } = await pairing.upsertPairingRequest({
          id: params.payload.user_id,
          meta: { name: params.userName },
        });
        return {
          ephemeral_text: core.channel.pairing.buildPairingReply({
            channel: "mattermost",
            idLine: `Your Mattermost user id: ${params.payload.user_id}`,
            code,
          }),
        };
      }
      const denyText =
        auth.denyReason === "unknown-channel"
          ? "Temporary error: unable to determine channel type. Please try again."
          : auth.denyReason === "dm-disabled"
            ? "This bot is not accepting direct messages."
            : auth.denyReason === "channels-disabled"
              ? "Model picker actions are disabled in channels."
              : auth.denyReason === "channel-no-allowlist"
                ? "Model picker actions are not configured for this channel."
                : "Unauthorized.";
      return { ephemeral_text: denyText };
    }

    const teamId = auth.channelInfo.team_id ?? params.payload.team_id ?? undefined;
    const eventPlan = await buildMattermostEventPlan(monitor, {
      channelId: params.payload.channel_id,
      senderId: params.payload.user_id,
      postId: params.post.id || params.payload.post_id,
      threadRootId: params.post.root_id,
      channelInfo: auth.channelInfo,
      teamId,
      channelName: auth.channelName,
      channelDisplay: auth.channelDisplay,
      dropLabel: "model picker event",
    });
    if (!eventPlan) {
      return {
        ephemeral_text: "Temporary error: unable to determine channel type. Please try again.",
      };
    }
    const modelSessionRoute = {
      agentId: eventPlan.route.agentId,
      sessionKey: eventPlan.thread.sessionKey,
    };
    const sessionEntry = await getSessionEntryAsync({
      agentId: modelSessionRoute.agentId,
      storePath: resolveStorePath(cfg.session?.store, { agentId: modelSessionRoute.agentId }),
      sessionKey: modelSessionRoute.sessionKey,
      readConsistency: "latest",
    });
    const data = await buildPreparedModelsProviderData(cfg, eventPlan.route.agentId, {
      sessionEntry,
    });
    const updatePickerPost = async (
      message: string,
      buttons?: MattermostInteractiveButtonInput[][],
    ) => {
      const text = [data.refreshWarning, message].filter(Boolean).join("\n\n");
      const response = await updateModelPickerPost({
        channelId: params.payload.channel_id,
        postId: params.payload.post_id,
        message: text,
        buttons,
      });
      await recordDeliveredCommandExchange({
        config: cfg,
        ...modelSessionRoute,
        expectedSessionId: sessionEntry?.sessionId,
        commandText: pickerCommandText,
        commandId: `mattermost:${account.accountId}:${params.payload.channel_id}:${params.payload.post_id}:${params.payload.user_id}:${pickerCommandText}:${"page" in pickerState ? pickerState.page : 1}`,
        replyId: "picker-update",
        replyText: [
          text,
          ...(buttons ?? []).map((row) => row.map((button) => button.text).join(", ")),
        ].join("\n"),
      });
      return response;
    };
    if (data.providers.length === 0) {
      return await updatePickerPost("No models available.");
    }

    if (pickerState.action !== "select") {
      const currentModel = resolveMattermostModelPickerCurrentModel({
        cfg,
        route: modelSessionRoute,
        data,
      });
      const viewParams = {
        ownerUserId: pickerState.ownerUserId,
        data,
        currentModel,
      };
      const view =
        pickerState.action === "list"
          ? renderMattermostModelsPickerView({
              ...viewParams,
              provider: pickerState.provider,
              page: pickerState.page,
            })
          : renderMattermostProviderPickerView(viewParams);
      return await updatePickerPost(view.text, view.buttons);
    }

    const targetModelRef = `${pickerState.provider}/${pickerState.model}`;
    if (!buildMattermostAllowedModelRefs(data).has(targetModelRef)) {
      return { ephemeral_text: `That model is no longer available: ${targetModelRef}` };
    }
    const messageSid = buildMattermostModelPickerSelectMessageSid({
      postId: params.payload.post_id,
      provider: pickerState.provider,
      model: pickerState.model,
    });

    // The HTTP response returns before the command finishes. Reserve a new root
    // while the request is still admitted so session dispatch survives that ack.
    void runDetachedWebhookWork(async () => {
      const commandText = `/model ${targetModelRef}`;
      const sourcePostId = params.post.id || params.payload.post_id;
      const { channelDisplay, kind, roomLabel } = eventPlan;
      const fromLabel =
        kind === "direct"
          ? `Mattermost DM from ${params.userName}`
          : `Mattermost message in ${roomLabel} from ${params.userName}`;
      const ctxPayload = eventPlan.finalizeContext({
        Body: commandText,
        BodyForAgent: commandText,
        RawBody: commandText,
        CommandBody: commandText,
        ConversationLabel: fromLabel,
        GroupSubject: kind !== "direct" ? channelDisplay || roomLabel : undefined,
        SenderName: params.userName,
        MessageSid: messageSid,
        Timestamp: Date.now(),
        WasMentioned: true,
        CommandAuthorized: auth.commandAuthorized,
        CommandSource: "native" as const,
      });
      await dispatchMattermostInteractionReply(monitor, eventPlan, {
        ctxPayload,
        interactionMessageSid: messageSid,
        sourcePostId,
        kind: "model picker",
      });
      const currentModel = resolveMattermostModelPickerCurrentModel({
        cfg,
        route: modelSessionRoute,
        data,
        readConsistency: "latest",
      });
      const view = renderMattermostModelsPickerView({
        ownerUserId: pickerState.ownerUserId,
        data,
        provider: pickerState.provider,
        page: pickerState.page,
        currentModel,
      });
      await updatePickerPost(view.text, view.buttons);
    }).catch((err: unknown) => {
      runtime.error?.(`mattermost model picker select failed: ${String(err)}`);
    });

    return {};
  };
}

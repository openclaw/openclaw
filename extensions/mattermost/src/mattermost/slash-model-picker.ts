import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { getSessionEntryAsync, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { recordDeliveredCommandExchange } from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  renderMattermostModelSummaryView,
  renderMattermostModelsPickerView,
  renderMattermostProviderPickerView,
  resolveMattermostModelPickerCurrentModel,
} from "./model-picker.js";
import type { MattermostModelPickerEntry } from "./model-picker.js";
import { buildPreparedModelsProviderData, type OpenClawConfig } from "./runtime-api.js";
import { sendMessageMattermost } from "./send.js";

/** Returns whether the reply contains models, rather than an empty-catalog notice. */
export async function deliverMattermostSlashModelPicker(params: {
  cfg: OpenClawConfig;
  route: Pick<ResolvedAgentRoute, "agentId" | "sessionKey">;
  accountId: string;
  channelId: string;
  senderId: string;
  commandText: string;
  messageSid: string;
  entry: MattermostModelPickerEntry;
}): Promise<boolean> {
  const { cfg, route, accountId, channelId, senderId, commandText, messageSid, entry } = params;
  const sessionEntry = await getSessionEntryAsync({
    agentId: route.agentId,
    storePath: resolveStorePath(cfg.session?.store, { agentId: route.agentId }),
    sessionKey: route.sessionKey,
    readConsistency: "latest",
  });
  const data = await buildPreparedModelsProviderData(cfg, route.agentId, { sessionEntry });
  if (data.providers.length === 0) {
    const delivered = await sendMessageMattermost(
      `channel:${channelId}`,
      [data.refreshWarning, "No models available."].filter(Boolean).join("\n\n"),
      { cfg, accountId },
    );
    await recordDeliveredCommandExchange({
      config: cfg,
      agentId: route.agentId,
      sessionKey: route.sessionKey,
      expectedSessionId: sessionEntry?.sessionId,
      commandText,
      commandId: `mattermost:${accountId}:${channelId}:${messageSid}`,
      replyId: "model-picker",
      replyText: delivered.content,
    });
    return false;
  }

  const currentModel = await resolveMattermostModelPickerCurrentModel({ cfg, route, data });
  const viewParams = { ownerUserId: senderId, data, currentModel };
  const view =
    entry.kind === "summary"
      ? renderMattermostModelSummaryView(viewParams)
      : entry.kind === "providers"
        ? renderMattermostProviderPickerView(viewParams)
        : renderMattermostModelsPickerView({
            ...viewParams,
            provider: entry.provider,
            page: 1,
          });
  const delivered = await sendMessageMattermost(
    `channel:${channelId}`,
    [data.refreshWarning, view.text].filter(Boolean).join("\n\n"),
    { cfg, accountId, buttons: view.buttons },
  );
  await recordDeliveredCommandExchange({
    config: cfg,
    agentId: route.agentId,
    sessionKey: route.sessionKey,
    expectedSessionId: sessionEntry?.sessionId,
    commandText,
    commandId: `mattermost:${accountId}:${channelId}:${messageSid}`,
    replyId: "model-picker",
    replyText: [
      delivered.content,
      ...view.buttons.map((row) => row.map((button) => button.text).join(", ")),
    ].join("\n"),
  });
  return true;
}

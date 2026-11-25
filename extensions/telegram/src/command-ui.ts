import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { fitsTelegramCallbackData } from "./approval-callback-data.js";
import {
  buildBrowseProvidersButton,
  buildModelsKeyboard,
  buildPaginationRow,
  buildProviderKeyboard,
  type ProviderInfo,
  type ModelsKeyboardParams,
} from "./model-buttons.js";
import { buildTelegramNativeCommandCallbackData } from "./native-command-callback-data.js";

function withTelegramButtons(
  buttons: ReturnType<typeof buildModelsKeyboard>,
): ReplyPayload["channelData"] {
  return { telegram: { buttons } };
}

export function buildCommandsPaginationKeyboard(
  currentPage: number,
  totalPages: number,
  agentId?: string,
): Array<Array<{ text: string; callback_data: string }>> {
  return [
    buildPaginationRow(currentPage, totalPages, (page) => {
      const data = `commands_page_${page ?? "noop"}`;
      const withAgent = `${data}:${agentId}`;
      // Telegram rejects the whole message when one callback_data exceeds 64 bytes, and
      // agent ids go up to 64 characters. Without the suffix, a tap uses the chat's agent.
      return agentId && fitsTelegramCallbackData(withAgent) ? withAgent : data;
    }),
  ];
}

export function buildTelegramCommandsListChannelData(params: {
  currentPage: number;
  totalPages: number;
  agentId?: string;
}): ReplyPayload["channelData"] | null {
  if (params.totalPages <= 1) {
    return null;
  }
  return withTelegramButtons(
    buildCommandsPaginationKeyboard(params.currentPage, params.totalPages, params.agentId),
  );
}

export function buildTelegramModelsProviderChannelData(params: {
  providers: ProviderInfo[];
}): ReplyPayload["channelData"] | null {
  if (params.providers.length === 0) {
    return null;
  }
  return withTelegramButtons(buildProviderKeyboard(params.providers));
}

export function buildTelegramModelsAddProviderChannelData(params: {
  providers: Array<{ id: string }>;
}): ReplyPayload["channelData"] | null {
  if (params.providers.length === 0) {
    return null;
  }
  const buttons = params.providers.map((provider) => [
    {
      text: provider.id,
      callback_data: buildTelegramNativeCommandCallbackData(`/models add ${provider.id}`),
    },
  ]);
  return withTelegramButtons(buttons);
}

export function buildTelegramModelsListChannelData(
  params: ModelsKeyboardParams,
): ReplyPayload["channelData"] | null {
  return withTelegramButtons(buildModelsKeyboard(params));
}

export function buildTelegramModelBrowseChannelData(): ReplyPayload["channelData"] {
  return withTelegramButtons(buildBrowseProvidersButton());
}

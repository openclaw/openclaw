import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import {
  buildBrowseProvidersButton,
  buildModelsKeyboard,
  buildProviderKeyboard,
  type ProviderInfo,
  type ModelsKeyboardParams,
} from "./model-buttons.js";
import { buildTelegramNativeCommandCallbackData } from "./native-command-callback-data.js";

export function buildCommandsPaginationKeyboard(
  currentPage: number,
  totalPages: number,
  agentId?: string,
): Array<Array<{ text: string; callback_data: string }>> {
  const buttons: Array<{ text: string; callback_data: string }> = [];
  const suffix = agentId ? `:${agentId}` : "";

  if (currentPage > 1) {
    buttons.push({
      text: "◀ Prev",
      callback_data: `commands_page_${currentPage - 1}${suffix}`,
    });
  }

  buttons.push({
    text: `${currentPage}/${totalPages}`,
    callback_data: `commands_page_noop${suffix}`,
  });

  if (currentPage < totalPages) {
    buttons.push({
      text: "Next ▶",
      callback_data: `commands_page_${currentPage + 1}${suffix}`,
    });
  }

  return [buttons];
}

export function buildTelegramCommandsListChannelData(params: {
  currentPage: number;
  totalPages: number;
  agentId?: string;
}): ReplyPayload["channelData"] | null {
  if (params.totalPages <= 1) {
    return null;
  }
  return {
    telegram: {
      buttons: buildCommandsPaginationKeyboard(
        params.currentPage,
        params.totalPages,
        params.agentId,
      ),
    },
  };
}

export function buildTelegramModelsProviderChannelData(params: {
  providers: ProviderInfo[];
}): ReplyPayload["channelData"] | null {
  if (params.providers.length === 0) {
    return null;
  }
  return {
    telegram: {
      buttons: buildProviderKeyboard(params.providers),
    },
  };
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
  return {
    telegram: {
      buttons,
    },
  };
}

export function buildTelegramModelsListChannelData(
  params: ModelsKeyboardParams,
): ReplyPayload["channelData"] | null {
  return {
    telegram: {
      buttons: buildModelsKeyboard(params),
    },
  };
}

export function buildTelegramModelBrowseChannelData(): ReplyPayload["channelData"] {
  return {
    telegram: {
      buttons: buildBrowseProvidersButton(),
    },
  };
}

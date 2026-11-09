import { createHash } from "node:crypto";
import { listAgentIds } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
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

// Agent ids are [a-z0-9_-], so "~" marks a digest and never collides with a literal id.
const HASHED_AGENT_MARKER = "~";

function hashCommandsPageAgentId(agentId: string): string {
  return createHash("sha256")
    .update(`openclaw.telegram.commands-page-agent.v1\0${agentId}`)
    .digest("base64url");
}

/** Resolve the agent from a `commands_page_<n>:<suffix>` suffix; undefined = use the session agent. */
export function resolveCommandsPageAgentId(
  cfg: OpenClawConfig,
  suffix: string | undefined,
): string | undefined {
  const value = suffix?.trim();
  if (!value?.startsWith(HASHED_AGENT_MARKER)) {
    return value || undefined;
  }
  const digest = value.slice(HASHED_AGENT_MARKER.length);
  return listAgentIds(cfg).find((agentId) => hashCommandsPageAgentId(agentId) === digest);
}

export function buildCommandsPaginationKeyboard(
  currentPage: number,
  totalPages: number,
  agentId?: string,
): Array<Array<{ text: string; callback_data: string }>> {
  return [
    buildPaginationRow(currentPage, totalPages, (page) => {
      const prefix = `commands_page_${page ?? "noop"}`;
      if (!agentId) {
        return prefix;
      }
      const exact = `${prefix}:${agentId}`;
      // Telegram rejects the whole message when callback_data exceeds 64 bytes (agent ids go up to 64).
      return fitsTelegramCallbackData(exact)
        ? exact
        : `${prefix}:${HASHED_AGENT_MARKER}${hashCommandsPageAgentId(agentId)}`;
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

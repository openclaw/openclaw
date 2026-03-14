import type { OpenClawConfig, ReplyPayload } from "openclaw/plugin-sdk";
import {
  buildModelsProviderData,
  formatModelsAvailableHeader,
  type ModelsProviderData,
} from "../../../../src/auto-reply/reply/commands-models.js";
import { resolveStoredModelOverride } from "../../../../src/auto-reply/reply/model-selection.js";
import {
  loadSessionStore,
  resolveStorePath,
  type SessionEntry,
} from "../../../../src/config/sessions.js";
import {
  buildModelsKeyboard,
  buildProviderKeyboard,
  calculateTotalPages,
  getModelsPageSize,
  parseModelCallbackData,
  resolveModelSelection,
  type ParsedModelCallback,
  type ProviderInfo,
} from "../../../../src/telegram/model-buttons.js";
import { readZulipComponentSpec, type ZulipComponentSpec } from "./components.js";

export type ZulipModelPickerRender = {
  text: string;
  spec: ZulipComponentSpec;
};

export type ZulipModelPickerCallbackAction =
  | { kind: "render"; render: ZulipModelPickerRender }
  | { kind: "command"; commandText: string }
  | { kind: "text"; text: string };

type TextOnlyAction = { kind: "text"; text: string };

type PickerSessionState = {
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
};

function buildProviderInfo(modelData: ModelsProviderData): ProviderInfo[] {
  return modelData.providers.map((provider) => ({
    id: provider,
    count: modelData.byProvider.get(provider)?.size ?? 0,
  }));
}

function loadPickerSessionState(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
}): PickerSessionState {
  const sessionKey = params.sessionKey?.trim();
  const agentId = params.agentId?.trim();
  if (!sessionKey || !agentId) {
    return {};
  }
  try {
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
    const sessionStore = loadSessionStore(storePath);
    return {
      sessionEntry: sessionStore[sessionKey],
      sessionStore,
    };
  } catch {
    return {};
  }
}

function resolveCurrentModelLabel(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  agentId?: string;
  modelData: ModelsProviderData;
}): { currentModel: string; sessionEntry?: SessionEntry } {
  const sessionState = loadPickerSessionState(params);
  const stored = resolveStoredModelOverride({
    sessionEntry: sessionState.sessionEntry,
    sessionStore: sessionState.sessionStore,
    sessionKey: params.sessionKey,
  });
  if (stored?.model) {
    return {
      currentModel: `${stored.provider ?? params.modelData.resolvedDefault.provider}/${stored.model}`,
      sessionEntry: sessionState.sessionEntry,
    };
  }
  return {
    currentModel: `${params.modelData.resolvedDefault.provider}/${params.modelData.resolvedDefault.model}`,
    sessionEntry: sessionState.sessionEntry,
  };
}

function isTextOnlyAction(value: ZulipModelPickerRender | TextOnlyAction): value is TextOnlyAction {
  return "kind" in value;
}

function buildProvidersRender(params: {
  modelData: ModelsProviderData;
  introText?: string;
  allowedUserIds?: number[];
}): ZulipModelPickerRender | TextOnlyAction {
  const providerInfos = buildProviderInfo(params.modelData);
  if (providerInfos.length === 0) {
    return { kind: "text", text: "No providers available." };
  }
  return {
    text: params.introText?.trim()
      ? `${params.introText.trim()}\n\nSelect a provider:`
      : "Select a provider:",
    spec: readZulipComponentSpec({
      heading: "Model Providers",
      buttons: buildProviderKeyboard(providerInfos).map((row) =>
        row.map((button) => ({
          ...button,
          allowedUsers: params.allowedUserIds,
        })),
      ),
    }),
  };
}

export function buildZulipModelPickerReply(params: {
  text: string;
  spec: ZulipComponentSpec;
}): ReplyPayload {
  return {
    text: params.text,
    channelData: {
      zulip: {
        heading: params.spec.heading,
        buttons: params.spec.buttons.map((button) => ({
          text: button.label,
          callback_data: button.callbackData,
          style: button.style,
          allowed_users: button.allowedUsers,
        })),
      },
    },
  };
}

export async function buildZulipModelPickerProvidersReply(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  introText?: string;
  allowedUserIds?: number[];
}): Promise<ReplyPayload | null> {
  const modelData = await buildModelsProviderData(params.cfg, params.agentId);
  const render = buildProvidersRender({
    modelData,
    introText: params.introText,
    allowedUserIds: params.allowedUserIds,
  });
  if (isTextOnlyAction(render)) {
    return { text: render.text };
  }
  return buildZulipModelPickerReply(render);
}

export async function buildZulipModelPickerModelsReply(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  provider: string;
  page: number;
  allowedUserIds?: number[];
}): Promise<ReplyPayload> {
  const modelData = await buildModelsProviderData(params.cfg, params.agentId);
  const render = buildModelsRender({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    provider: params.provider,
    page: params.page,
    modelData,
    allowedUserIds: params.allowedUserIds,
  });
  if (isTextOnlyAction(render)) {
    return { text: render.text };
  }
  return buildZulipModelPickerReply(render);
}

function buildModelsRender(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  provider: string;
  page: number;
  modelData: ModelsProviderData;
  allowedUserIds?: number[];
}): ZulipModelPickerRender | TextOnlyAction {
  const modelSet = params.modelData.byProvider.get(params.provider);
  if (!modelSet || modelSet.size === 0) {
    return buildProvidersRender({
      modelData: params.modelData,
      introText: `Unknown provider: ${params.provider}`,
      allowedUserIds: params.allowedUserIds,
    });
  }

  const models = [...modelSet].toSorted();
  const pageSize = getModelsPageSize();
  const totalPages = calculateTotalPages(models.length, pageSize);
  const safePage = Math.max(1, Math.min(params.page, totalPages));
  const { currentModel, sessionEntry } = resolveCurrentModelLabel({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    modelData: params.modelData,
  });

  return {
    text: formatModelsAvailableHeader({
      provider: params.provider,
      total: models.length,
      cfg: params.cfg,
      sessionEntry,
    }),
    spec: readZulipComponentSpec({
      heading: `${params.provider} models`,
      buttons: buildModelsKeyboard({
        provider: params.provider,
        models,
        currentModel,
        currentPage: safePage,
        totalPages,
        pageSize,
      }).map((row) =>
        row.map((button) => ({
          ...button,
          allowedUsers: params.allowedUserIds,
        })),
      ),
    }),
  };
}

export async function resolveZulipModelPickerCallbackAction(params: {
  cfg: OpenClawConfig;
  callbackData?: string | null;
  agentId?: string;
  sessionKey?: string;
  allowedUserIds?: number[];
}): Promise<ZulipModelPickerCallbackAction | null> {
  const callback = parseModelCallbackData(params.callbackData ?? "");
  if (!callback) {
    return null;
  }

  const modelData = await buildModelsProviderData(params.cfg, params.agentId);
  if (callback.type === "providers" || callback.type === "back") {
    const render = buildProvidersRender({ modelData, allowedUserIds: params.allowedUserIds });
    return isTextOnlyAction(render) ? render : { kind: "render", render };
  }

  if (callback.type === "list") {
    const render = buildModelsRender({
      cfg: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      provider: callback.provider,
      page: callback.page,
      modelData,
      allowedUserIds: params.allowedUserIds,
    });
    return isTextOnlyAction(render) ? render : { kind: "render", render };
  }

  const selection = resolveModelSelection({
    callback: callback,
    providers: modelData.providers,
    byProvider: modelData.byProvider,
  });
  if (selection.kind !== "resolved") {
    const render = buildProvidersRender({
      modelData,
      introText: `Could not resolve model "${selection.model}".`,
      allowedUserIds: params.allowedUserIds,
    });
    return isTextOnlyAction(render) ? render : { kind: "render", render };
  }

  return {
    kind: "command",
    commandText: `/model ${selection.provider}/${selection.model}`,
  };
}

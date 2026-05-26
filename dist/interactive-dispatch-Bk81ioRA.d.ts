import { r as ReplyPayload } from "./reply-payload-BlNiejVc.js";
import { mt as PluginInteractiveRegistration } from "./types-Vx7Jq4_-2.js";
import { Jt as PluginConversationBindingRequestResult, Kt as PluginConversationBinding, qt as PluginConversationBindingRequestParams } from "./hook-types-BKz-S4lu.js";
//#region extensions/telegram/src/model-buttons.d.ts
type ButtonRow = Array<{
  text: string;
  callback_data: string;
}>;
type ParsedModelCallback = {
  type: "providers";
} | {
  type: "list";
  provider: string;
  page: number;
} | {
  type: "select";
  provider?: string;
  model: string;
} | {
  type: "back";
};
type ProviderInfo = {
  id: string;
  count: number;
};
type ResolveModelSelectionResult = {
  kind: "resolved";
  provider: string;
  model: string;
} | {
  kind: "ambiguous";
  model: string;
  matchingProviders: string[];
};
type ModelsKeyboardParams = {
  provider: string;
  models: readonly string[];
  currentModel?: string;
  currentPage: number;
  totalPages: number;
  pageSize?: number;
  /** Optional map from provider/model to display name. When provided, the
   *  display name is shown on the button instead of the raw model ID. */
  modelNames?: ReadonlyMap<string, string>;
};
/**
 * Parse a model callback_data string into a structured object.
 * Returns null if the data doesn't match a known pattern.
 */
declare function parseModelCallbackData(data: string): ParsedModelCallback | null;
declare function buildModelSelectionCallbackData(params: {
  provider: string;
  model: string;
}): string | null;
declare function resolveModelSelection(params: {
  callback: Extract<ParsedModelCallback, {
    type: "select";
  }>;
  providers: readonly string[];
  byProvider: ReadonlyMap<string, ReadonlySet<string>>;
}): ResolveModelSelectionResult;
/**
 * Build provider selection keyboard with 2 providers per row.
 */
declare function buildProviderKeyboard(providers: ProviderInfo[]): ButtonRow[];
/**
 * Build model list keyboard with pagination and back button.
 */
declare function buildModelsKeyboard(params: ModelsKeyboardParams): ButtonRow[];
/**
 * Build "Browse providers" button for /model summary.
 */
declare function buildBrowseProvidersButton(): ButtonRow[];
/**
 * Get page size for model list pagination.
 */
declare function getModelsPageSize(): number;
/**
 * Calculate total pages for a model list.
 */
declare function calculateTotalPages(totalModels: number, pageSize?: number): number;
//#endregion
//#region extensions/telegram/src/command-ui.d.ts
declare function buildCommandsPaginationKeyboard(currentPage: number, totalPages: number, agentId?: string): Array<Array<{
  text: string;
  callback_data: string;
}>>;
declare function buildTelegramModelsProviderChannelData(params: {
  providers: ProviderInfo[];
}): ReplyPayload["channelData"] | null;
//#endregion
//#region extensions/telegram/src/interactive-dispatch.d.ts
type TelegramInteractiveButtons = Array<Array<{
  text: string;
  callback_data: string;
  style?: "danger" | "success" | "primary";
}>>;
type TelegramInteractiveHandlerContext = {
  channel: "telegram";
  accountId: string;
  callbackId: string;
  conversationId: string;
  parentConversationId?: string;
  senderId?: string;
  senderUsername?: string;
  threadId?: number;
  isGroup: boolean;
  isForum: boolean;
  auth: {
    isAuthorizedSender: boolean;
  };
  callback: {
    data: string;
    namespace: string;
    payload: string;
    messageId: number;
    chatId: string;
    messageText?: string;
  };
  respond: {
    reply: (params: {
      text: string;
      buttons?: TelegramInteractiveButtons;
    }) => Promise<void>;
    editMessage: (params: {
      text: string;
      buttons?: TelegramInteractiveButtons;
    }) => Promise<void>;
    editButtons: (params: {
      buttons: TelegramInteractiveButtons;
    }) => Promise<void>;
    clearButtons: () => Promise<void>;
    deleteMessage: () => Promise<void>;
  };
  requestConversationBinding: (params?: PluginConversationBindingRequestParams) => Promise<PluginConversationBindingRequestResult>;
  detachConversationBinding: () => Promise<{
    removed: boolean;
  }>;
  getCurrentConversationBinding: () => Promise<PluginConversationBinding | null>;
};
type TelegramInteractiveHandlerRegistration = PluginInteractiveRegistration<TelegramInteractiveHandlerContext, "telegram">;
//#endregion
export { resolveModelSelection as _, ButtonRow as a, ProviderInfo as c, buildModelSelectionCallbackData as d, buildModelsKeyboard as f, parseModelCallbackData as g, getModelsPageSize as h, buildTelegramModelsProviderChannelData as i, ResolveModelSelectionResult as l, calculateTotalPages as m, TelegramInteractiveHandlerRegistration as n, ModelsKeyboardParams as o, buildProviderKeyboard as p, buildCommandsPaginationKeyboard as r, ParsedModelCallback as s, TelegramInteractiveHandlerContext as t, buildBrowseProvidersButton as u };
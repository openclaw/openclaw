import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { registerClickClackCommandSuggestionsRoute } from "./src/command-suggestions-http.js";

export {
  DEFAULT_ACCOUNT_ID,
  listClickClackAccountIds,
  listEnabledClickClackAccounts,
  resolveClickClackAccount,
  resolveDefaultClickClackAccountId,
} from "./src/accounts.js";
export { clickClackPlugin } from "./src/channel.js";
export {
  resolveClickClackCommandSuggestions,
  type ClickClackCommandSuggestion,
  type ClickClackCommandSuggestionRequest,
  type ClickClackCommandSuggestionResponse,
} from "./src/command-suggestions.js";
export {
  handleClickClackCommandSuggestionsHttp,
  registerClickClackCommandSuggestionsRoute,
} from "./src/command-suggestions-http.js";
export { clickClackConfigSchema } from "./src/config-schema.js";
export { createClickClackClient } from "./src/http-client.js";
export { getClickClackRuntime, setClickClackRuntime } from "./src/runtime.js";
export { buildClickClackTarget, parseClickClackTarget } from "./src/target.js";
export type {
  ClickClackAccountConfig,
  ClickClackEvent,
  ClickClackMessage,
  ClickClackTarget,
  CoreConfig,
  ResolvedClickClackAccount,
} from "./src/types.js";

export function registerClickClackHttpRoutes(api: OpenClawPluginApi): void {
  registerClickClackCommandSuggestionsRoute(api);
}

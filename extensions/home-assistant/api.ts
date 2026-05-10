export {
  homeAssistantConfigSchema,
  parseHomeAssistantConfig,
  type HomeAssistantConfig,
  type HomeAssistantConfigParseIssue,
  type HomeAssistantConfigParseResult,
} from "./config-schema.js";
export {
  DEFAULT_HOME_ASSISTANT_URL,
  DEFAULT_TOKEN_REF,
  DEFAULT_DENY_SERVICE_LIST,
} from "./config-defaults.js";
export { registerHomeAssistantPlugin } from "./register.runtime.js";

// Setup helpers shared with the host CLI.
export {
  DEFAULT_GMAIL_LABEL,
  DEFAULT_GMAIL_MAX_BYTES,
  DEFAULT_GMAIL_RENEW_MINUTES,
  DEFAULT_GMAIL_SERVE_BIND,
  DEFAULT_GMAIL_SERVE_PATH,
  DEFAULT_GMAIL_SERVE_PORT,
  DEFAULT_GMAIL_SUBSCRIPTION,
  DEFAULT_GMAIL_TOPIC,
  resolveGmailHookMaxBytes,
} from "openclaw/plugin-sdk/gateway-config-runtime";
export {
  buildDefaultHookUrl,
  buildGogWatchStartArgs,
  buildTopicPath,
  GMAIL_INSECURE_TOKEN_ARGS_WARNING,
  type GmailHookOverrides,
  mergeHookPresets,
  normalizeHooksPath,
  normalizeServePath,
  parseTopicPath,
  resolveGmailHookRuntimeConfig,
} from "./src/gmail.js";

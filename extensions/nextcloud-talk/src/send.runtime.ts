// Nextcloud Talk plugin module implements send behavior.
export { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
export { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
export { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";

export { resolveNextcloudTalkAccount } from "./accounts.js";
export { getNextcloudTalkRuntime } from "./runtime.js";
export { generateNextcloudTalkSignature } from "./signature.js";

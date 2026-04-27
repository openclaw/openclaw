export { slackPlugin } from "./src/channel.js";
export { slackSetupPlugin } from "./src/channel.setup.js";
export * from "./src/account-inspect.js";
export * from "./src/accounts.js";
export * from "./src/action-threading.js";
export * from "./src/actions.js";
export * from "./src/blocks-input.js";
export * from "./src/blocks-render.js";
export * from "./src/channel-type.js";
export * from "./src/client.js";
export * from "./src/directory-config.js";
export * from "./src/http/index.js";
export type {
  SlackInteractiveHandlerContext,
  SlackInteractiveHandlerRegistration,
} from "./src/interactive-dispatch.js";
export * from "./src/interactive-replies.js";
export * from "./src/message-actions.js";
export * from "./src/group-policy.js";
export * from "./src/monitor/allow-list.js";
export * from "./src/probe.js";
export * from "./src/security-audit.js";
// Explicitly list public exports so test-only helpers (_flushPersist,
// _resetForTests) stay internal. A wildcard export would re-export those
// underscored helpers as part of the slack extension's public API,
// allowing same-process consumers to redirect the persist path and
// trigger arbitrary writes/renames/unlinks (clawsweeper review on
// PR #33845).
export {
  recordSlackThreadParticipation,
  hasSlackThreadParticipation,
  clearSlackThreadParticipationCache,
} from "./src/sent-thread-cache.js";
export * from "./src/targets.js";
export * from "./src/threading-tool-context.js";
export { resolveSlackRuntimeGroupPolicy } from "./src/monitor/provider.js";

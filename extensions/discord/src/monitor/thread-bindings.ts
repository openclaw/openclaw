export type {
  ThreadBindingManager,
  ThreadBindingRecord,
  ThreadBindingTargetKind,
} from "./thread-bindings.types.js";

export {
  formatThreadBindingDurationLabel,
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "openclaw/plugin-sdk/conversation-runtime";
export {
  resolveThreadBindingPersona,
  resolveThreadBindingPersonaFromRecord,
} from "./thread-bindings.persona.js";

export {
  resolveDiscordThreadBindingIdleTimeoutMs,
  resolveDiscordThreadBindingMaxAgeMs,
  resolveThreadBindingsEnabled,
} from "./thread-bindings.config.js";

export {
  resolveThreadBindingIdleTimeoutMs,
  resolveThreadBindingInactivityExpiresAt,
  resolveThreadBindingMaxAgeExpiresAt,
  resolveThreadBindingMaxAgeMs,
} from "./thread-bindings.state.js";

export {
  autoBindSpawnedDiscordSubagent,
  listThreadBindingsBySessionKey,
  listThreadBindingsForAccount,
  reconcileAcpThreadBindingsOnStartup,
  setThreadBindingIdleTimeoutBySessionKey,
  setThreadBindingIdleTimeoutBySessionKeyAsync,
  setThreadBindingMaxAgeBySessionKey,
  setThreadBindingMaxAgeBySessionKeyAsync,
  unbindThreadBindingsBySessionKey,
  unbindThreadBindingsBySessionKeyAsync,
} from "./thread-bindings.lifecycle.js";

export type { AcpThreadBindingReconciliationResult } from "./thread-bindings.lifecycle.js";

export { createThreadBindingManager, getThreadBindingManager } from "./thread-bindings.manager.js";

export { createNoopThreadBindingManager } from "./thread-bindings.session-adapter.js";

export {
	resolveDiscordThreadBindingIdleTimeoutMs,
	resolveDiscordThreadBindingMaxAgeMs,
	resolveThreadBindingsEnabled,
} from "./thread-bindings.config.js";
export type { AcpThreadBindingReconciliationResult } from "./thread-bindings.lifecycle.js";
export {
	autoBindSpawnedDiscordSubagent,
	listThreadBindingsBySessionKey,
	listThreadBindingsForAccount,
	reconcileAcpThreadBindingsOnStartup,
	setThreadBindingIdleTimeoutBySessionKey,
	setThreadBindingMaxAgeBySessionKey,
	unbindThreadBindingsBySessionKey,
} from "./thread-bindings.lifecycle.js";
export {
	__testing,
	createNoopThreadBindingManager,
	createThreadBindingManager,
	getThreadBindingManager,
} from "./thread-bindings.manager.js";
export {
	formatThreadBindingDurationLabel,
	resolveThreadBindingIntroText,
	resolveThreadBindingThreadName,
} from "./thread-bindings.messages.js";
export {
	resolveThreadBindingPersona,
	resolveThreadBindingPersonaFromRecord,
} from "./thread-bindings.persona.js";
export {
	isRecentlyUnboundThreadWebhookMessage,
	resolveThreadBindingIdleTimeoutMs,
	resolveThreadBindingInactivityExpiresAt,
	resolveThreadBindingMaxAgeExpiresAt,
	resolveThreadBindingMaxAgeMs,
} from "./thread-bindings.state.js";
export type {
	ThreadBindingManager,
	ThreadBindingRecord,
	ThreadBindingTargetKind,
} from "./thread-bindings.types.js";

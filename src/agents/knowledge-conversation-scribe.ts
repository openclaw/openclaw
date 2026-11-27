// Stable declaration key for built-in Knowledge jobs, also the prefix of the
// Control UI start request's idempotency key. Existing jobs keep this key even
// when their prompt or display name changes.
export const KNOWLEDGE_CONVERSATION_SCRIBE = "knowledge:scribe:conversations";

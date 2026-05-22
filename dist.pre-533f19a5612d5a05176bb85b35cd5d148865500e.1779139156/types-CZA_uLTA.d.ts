//#region src/agents/pi-embedded-helpers/types.d.ts
type EmbeddedContextFile = {
  path: string;
  content: string;
};
type FailoverReason = "auth" | "auth_permanent" | "format" | "rate_limit" | "overloaded" | "billing" | "server_error" | "timeout" | "model_not_found" | "session_expired" | "empty_response" | "no_error_details" | "unclassified" | "unknown";
//#endregion
export { FailoverReason as n, EmbeddedContextFile as t };
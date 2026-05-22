//#region extensions/github-copilot/connection-bound-ids.d.ts
declare function sanitizeCopilotReplayResponseIds(input: unknown): boolean;
declare function rewriteCopilotConnectionBoundResponseIds(input: unknown): boolean;
declare function sanitizeCopilotReplayResponsePayloadIds(payload: unknown): boolean;
declare function rewriteCopilotResponsePayloadConnectionBoundIds(payload: unknown): boolean;
//#endregion
export { rewriteCopilotConnectionBoundResponseIds, rewriteCopilotResponsePayloadConnectionBoundIds, sanitizeCopilotReplayResponseIds, sanitizeCopilotReplayResponsePayloadIds };
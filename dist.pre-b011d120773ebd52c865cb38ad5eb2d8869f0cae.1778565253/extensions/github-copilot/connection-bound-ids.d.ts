//#region extensions/github-copilot/connection-bound-ids.d.ts
declare function rewriteCopilotConnectionBoundResponseIds(input: unknown): boolean;
declare function rewriteCopilotResponsePayloadConnectionBoundIds(payload: unknown): boolean;
//#endregion
export { rewriteCopilotConnectionBoundResponseIds, rewriteCopilotResponsePayloadConnectionBoundIds };
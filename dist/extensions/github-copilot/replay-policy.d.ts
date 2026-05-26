//#region extensions/github-copilot/replay-policy.d.ts
declare function buildGithubCopilotReplayPolicy(modelId?: string): {
  dropThinkingBlocks: boolean;
} | {
  dropThinkingBlocks?: undefined;
};
//#endregion
export { buildGithubCopilotReplayPolicy };
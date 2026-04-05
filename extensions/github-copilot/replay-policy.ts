export function buildGithubCopilotReplayPolicy(modelId?: string) {
  return (modelId?.toLowerCase() ?? "").includes("claude")
    ? {
        dropThinkingBlocks: true,
      }
    : {};
}

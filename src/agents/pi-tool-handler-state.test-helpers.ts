export function createBaseToolHandlerState() {
  return {
    toolMetas: [] as Array<{ toolName?: string; meta?: string }>,
    toolSummaryById: new Set<string>(),
    lastToolError: undefined,
    pendingMessagingTexts: new Map<string, string>(),
    pendingMessagingTargets: new Map<string, unknown>(),
    pendingMessagingMediaUrls: new Map<string, string[]>(),
    pendingToolMediaUrls: [] as string[],
    pendingToolAudioAsVoice: false,
    messagingToolSentTexts: [] as string[],
    messagingToolSentTextsNormalized: [] as string[],
    messagingToolSentMediaUrls: [] as string[],
    messagingToolSentTargets: [] as unknown[],
    deterministicApprovalPromptSent: false,
    visibleOutputEmittedThisTurn: false,
    blockBuffer: "",
  };
}

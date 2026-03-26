export function createBaseToolHandlerState() {
  return {
    toolMetas: [] as Array<{ toolName?: string; meta?: string }>,
    verifyEntries: [] as Array<{
      toolName: string;
      meta?: string;
      command: string;
      kind: "test" | "build" | "lint" | "check" | "command";
      status: "passed" | "failed";
      exitCode: number | null;
      source: "tool-result";
    }>,
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
    successfulCronAdds: 0,
    deterministicApprovalPromptSent: false,
    blockBuffer: "",
  };
}

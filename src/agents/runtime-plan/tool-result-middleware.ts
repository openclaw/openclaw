import type { ActiveRuntimeMetadata } from "./active-registry";

export type ToolResultContext = {
  toolName: string;
  isSuccess: boolean;
  contentType?: string;
  mediaProvider?: string;
};

export type ToolResultProcessor = (
  context: ToolResultContext,
  registry: ActiveRuntimeMetadata,
) => { shouldProcess: boolean; processingHint?: string };

export function createToolResultProcessor(): ToolResultProcessor {
  return (context, registry) => {
    const { toolName, mediaProvider } = context;

    if (!mediaProvider) {
      return { shouldProcess: false };
    }

    const media = registry.media.get(mediaProvider);
    if (!media) {
      return {
        shouldProcess: false,
        processingHint: `Media provider '${mediaProvider}' not found in prepared runtime`,
      };
    }

    return {
      shouldProcess: true,
      processingHint: `Using prepared media provider: ${media.providerId}`,
    };
  };
}

export function processToolResult(
  result: unknown,
  processor: ToolResultProcessor,
  context: ToolResultContext,
  registry: ActiveRuntimeMetadata,
): { processed: boolean; metadata?: Record<string, unknown> } {
  const decision = processor(context, registry);

  if (!decision.shouldProcess) {
    return { processed: false };
  }

  return {
    processed: true,
    metadata: {
      hint: decision.processingHint,
      registryState: {
        hasMediaProvider: registry.media.size > 0 || context.mediaProvider ? "yes" : "no",
      },
    },
  };
}

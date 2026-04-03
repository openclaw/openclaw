import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import {
  createCodexNativeWebSearchWrapper,
  createOpenAIAttributionHeadersWrapper,
  createOpenAIFastModeWrapper,
  createOpenAIReasoningCompatibilityWrapper,
  createOpenAIResponsesContextManagementWrapper,
  createOpenAIServiceTierWrapper,
  createOpenAITextVerbosityWrapper,
  resolveOpenAIFastMode,
  resolveOpenAIServiceTier,
  resolveOpenAITextVerbosity,
} from "openclaw/plugin-sdk/provider-stream";

function applySharedOpenAIWrappers(
  streamFn: ProviderWrapStreamFnContext["streamFn"],
  ctx: ProviderWrapStreamFnContext,
) {
  // Transport-default ownership lives in prepareExtraParams. These wrappers stay
  // intentionally identical across direct OpenAI, Azure OpenAI, and Codex.
  let nextStreamFn = createOpenAIAttributionHeadersWrapper(streamFn);

  if (resolveOpenAIFastMode(ctx.extraParams)) {
    nextStreamFn = createOpenAIFastModeWrapper(nextStreamFn);
  }

  const serviceTier = resolveOpenAIServiceTier(ctx.extraParams);
  if (serviceTier) {
    nextStreamFn = createOpenAIServiceTierWrapper(nextStreamFn, serviceTier);
  }

  const textVerbosity = resolveOpenAITextVerbosity(ctx.extraParams);
  if (textVerbosity) {
    nextStreamFn = createOpenAITextVerbosityWrapper(nextStreamFn, textVerbosity);
  }

  nextStreamFn = createCodexNativeWebSearchWrapper(nextStreamFn, {
    config: ctx.config,
    agentDir: ctx.agentDir,
  });
  return createOpenAIResponsesContextManagementWrapper(
    createOpenAIReasoningCompatibilityWrapper(nextStreamFn),
    ctx.extraParams,
  );
}

/** Compose the direct OpenAI wrapper chain inside the owning provider plugin. */
export function wrapOpenAIProviderStream(ctx: ProviderWrapStreamFnContext) {
  return applySharedOpenAIWrappers(ctx.streamFn, ctx);
}

/** Compose the Azure OpenAI wrapper chain without direct OpenAI transport defaults. */
export function wrapAzureOpenAIProviderStream(ctx: ProviderWrapStreamFnContext) {
  return applySharedOpenAIWrappers(ctx.streamFn, ctx);
}

/** Compose the Codex-specific wrapper chain inside the owning provider plugin. */
export function wrapOpenAICodexProviderStream(ctx: ProviderWrapStreamFnContext) {
  return applySharedOpenAIWrappers(ctx.streamFn, ctx);
}

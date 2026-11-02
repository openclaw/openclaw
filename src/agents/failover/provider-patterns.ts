import { classifyProviderFailoverSignalWithPlugin } from "../../plugins/provider-failover.js";
import type { FailoverReason } from "./signal.js";
type ProviderSpecificErrorContext = {
  provider?: string;
  modelId?: string;
  errorMessage: string;
  status?: number;
  code?: string;
  errorType?: string;
  providerPlugin?: PreparedProviderFailoverOwner | null;
};
export type PreparedProviderFailoverOwner = {
  id: string;
  matchesContextOverflowError?: (ctx: ProviderSpecificErrorContext) => boolean | undefined;
  classifyFailoverReason?: (ctx: ProviderSpecificErrorContext) => FailoverReason | null | undefined;
};

export function classifyProviderPluginError(
  context: ProviderSpecificErrorContext,
): FailoverReason | null {
  const { providerPlugin, ...providerContext } = context;
  // Presentation has no provider owner; explicit absence must not trigger discovery.
  if (providerPlugin === null) {
    return null;
  }
  if (providerPlugin) {
    const ownedContext = { ...providerContext, provider: providerPlugin.id };
    if (providerPlugin.matchesContextOverflowError?.(ownedContext)) {
      return "context_overflow";
    }
    return providerPlugin.classifyFailoverReason?.(ownedContext) ?? null;
  }
  return (
    classifyProviderFailoverSignalWithPlugin({
      provider: context.provider,
      context: providerContext,
    }) ?? null
  );
}

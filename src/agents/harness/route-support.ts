import type {
  AgentHarness,
  AgentHarnessRouteSupport,
  AgentHarnessSupport,
  AgentHarnessSupportContext,
} from "./types.js";

/** Reject routes that a harness's declared transport cannot reproduce. */
export function resolveAgentHarnessRouteRejection(
  ctx: AgentHarnessSupportContext,
  facts: AgentHarnessRouteSupport,
): Extract<AgentHarnessSupport, { supported: false }> | undefined {
  const unsupported = (reason: string) => ({ supported: false as const, reason });
  const provider = ctx.provider.trim().toLowerCase();
  const route = ctx.modelProvider;
  const auth = route?.preparedAuth;
  const explicitlySelected = ctx.requestedRuntime === facts.runtimeId;
  const nativeCommand =
    facts.acceptsNativeCommand &&
    explicitlySelected &&
    route?.nativeCommandAuth?.runtimeId === facts.runtimeId &&
    route.requestTransportOverrides === "none" &&
    (!auth ||
      (auth.source === "harness" &&
        (auth.mode === undefined || auth.mode === "native-command") &&
        auth.requirement === undefined));
  // Use host intrinsics to read the data through the plugin's owned view.
  if (!Array.prototype.includes.call(facts.providerIds, provider) && !nativeCommand) {
    const providers = Array.prototype.toSorted.call(facts.providerIds);
    return unsupported(`provider is not one of: ${providers.join(", ")}`);
  }
  if (route?.requestTransportOverrides === "present") {
    return {
      ...unsupported(`${facts.runtimeName} cannot reproduce authored request transport overrides`),
      fallbackRuntime: "openclaw" as const,
    };
  }
  if (route?.runtimePolicy) {
    return route.runtimePolicy.compatibleIds.some(
      (id) => id.trim().toLowerCase() === facts.runtimeId,
    )
      ? undefined
      : unsupported(`${facts.runtimeName} cannot reproduce the prepared provider route`);
  }
  const nativeAccountOwnsUnobservedModel =
    provider === facts.unobservedModelProvider &&
    explicitlySelected &&
    Boolean(ctx.modelId?.trim()) &&
    (!auth || auth.source === "harness") &&
    auth?.mode === undefined &&
    auth?.requirement === undefined &&
    route?.api === undefined &&
    route?.baseUrl === undefined &&
    route?.azureApiVersion === undefined &&
    route?.request === undefined;
  if (
    route &&
    !(
      facts.routeOptionalProviderIds &&
      Array.prototype.includes.call(facts.routeOptionalProviderIds, provider)
    ) &&
    !nativeAccountOwnsUnobservedModel &&
    !nativeCommand
  ) {
    return unsupported(`provider route compatibility with ${facts.runtimeName} is not declared`);
  }
  return undefined;
}

/** Older harnesses and execution contexts continue through scoped support admission. */
export function resolveAgentHarnessSupport(
  harness: AgentHarness,
  context: AgentHarnessSupportContext,
  projection: boolean,
) {
  const facts =
    projection && !context.modelProvider?.preparedAuth ? harness.routeSupport : undefined;
  return facts
    ? (resolveAgentHarnessRouteRejection(context, facts) ?? facts.availability)
    : harness.supports(context);
}

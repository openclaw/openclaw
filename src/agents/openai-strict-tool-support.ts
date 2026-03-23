function getHeaderValue(
  headers: Record<string, string> | undefined,
  headerName: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  const target = headerName.toLowerCase();
  let matchedValue: string | undefined;
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === target) {
      matchedValue = value;
    }
  }
  return matchedValue;
}

export function isOpenRouterBaseUrl(baseUrl: unknown): boolean {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) {
    return false;
  }
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "openrouter.ai" || host === "api.openrouter.ai";
  } catch {
    return false;
  }
}

function resolveExclusiveOpenRouterProvider(model: { compat?: unknown }): string | undefined {
  const compat =
    model.compat && typeof model.compat === "object" && !Array.isArray(model.compat)
      ? (model.compat as { openRouterRouting?: unknown })
      : undefined;
  const routing =
    compat?.openRouterRouting &&
    typeof compat.openRouterRouting === "object" &&
    !Array.isArray(compat.openRouterRouting)
      ? (compat.openRouterRouting as {
          allow_fallbacks?: unknown;
          allowFallbacks?: unknown;
          only?: unknown;
          order?: unknown;
          providers?: unknown;
        })
      : undefined;
  const normalizeRoutingList = (value: unknown): string[] =>
    Array.isArray(value)
      ? value
          .flatMap((entry) => (typeof entry === "string" ? [entry.trim().toLowerCase()] : []))
          .filter(Boolean)
      : [];
  const allowFallbacks = routing?.allowFallbacks ?? routing?.allow_fallbacks;
  const order = normalizeRoutingList(routing?.order);
  if (allowFallbacks === false && order.length === 1) {
    return order[0];
  }

  const providers = normalizeRoutingList(routing?.providers);
  return providers.length === 1 ? providers[0] : undefined;
}

export function hasOpenRouterStrictToolSupportRoute(model: {
  baseUrl?: unknown;
  compat?: unknown;
  id?: unknown;
  headers?: unknown;
}): boolean {
  if (!isOpenRouterBaseUrl(model.baseUrl)) {
    return false;
  }

  const modelId = typeof model.id === "string" ? model.id.trim().toLowerCase() : "";
  const exclusiveProvider = resolveExclusiveOpenRouterProvider(model);
  if (exclusiveProvider === "openai") {
    return true;
  }
  if (modelId.startsWith("openai/")) {
    return exclusiveProvider === undefined;
  }
  if (exclusiveProvider && exclusiveProvider !== "anthropic") {
    return false;
  }
  if (!modelId.startsWith("anthropic/") && exclusiveProvider !== "anthropic") {
    return false;
  }

  const anthropicBetaHeader = getHeaderValue(
    model.headers && typeof model.headers === "object" && !Array.isArray(model.headers)
      ? (model.headers as Record<string, string>)
      : undefined,
    "x-anthropic-beta",
  );
  return (
    anthropicBetaHeader
      ?.split(",")
      .some((value) => value.trim() === "structured-outputs-2025-11-13") === true
  );
}

//#region extensions/openrouter/provider-routing.d.ts
type OpenRouterExtraParamsContext = {
  config?: {
    models?: {
      providers?: Record<string, {
        params?: Record<string, unknown>;
      }>;
    };
  };
  extraParams: Record<string, unknown>;
  provider: string;
  model?: {
    params?: Record<string, unknown>;
  };
};
declare function resolveOpenRouterExtraParamsForTransport(ctx: OpenRouterExtraParamsContext): {
  patch?: Record<string, unknown>;
} | undefined;
//#endregion
export { resolveOpenRouterExtraParamsForTransport };
type ConfiguredBindingConversationRuntimeModule = {
  ensureConfiguredBindingRouteReady: unknown;
  resolveConfiguredBindingRoute: unknown;
};

export async function createConfiguredBindingConversationRuntimeModuleMock<
  TModule extends ConfiguredBindingConversationRuntimeModule,
>(
  params: {
    ensureConfiguredBindingRouteReadyMock: (...args: unknown[]) => unknown;
    resolveConfiguredBindingRouteMock: (...args: unknown[]) => unknown;
  },
  importOriginal: () => Promise<TModule>,
): Promise<TModule> {
  const actual = await importOriginal();
  return {
    ...actual,
    ensureConfiguredBindingRouteReady: (...args: unknown[]) =>
      params.ensureConfiguredBindingRouteReadyMock(...args),
    resolveConfiguredBindingRoute: (...args: unknown[]) =>
      params.resolveConfiguredBindingRouteMock(...args),
  } as TModule;
}

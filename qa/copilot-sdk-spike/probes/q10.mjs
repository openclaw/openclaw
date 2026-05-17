/** Run the BYOK listModels API-shape probe. */
async function runQ10(ctx) {
  const clientText = await ctx.readInstalledText('dist/client.d.ts');
  const typesText = await ctx.readInstalledText('dist/types.d.ts');
  const listModelsSnippet = ctx.findSnippet(clientText, 'listModels(): Promise<ModelInfo[]>');
  const onListModelsSnippet = ctx.findSnippet(typesText, 'onListModels?: () => Promise<ModelInfo[]> | ModelInfo[];');
  const sessionProviderSnippet = ctx.findSnippet(typesText, 'provider?: ProviderConfig;');

  return {
    status: 'not-supported-by-api-shape',
    evidence: {
      listModelsSnippet,
      onListModelsSnippet,
      sessionProviderSnippet,
    },
    observed:
      'The installed API exposes provider only on SessionConfig, while client.listModels is client-scoped and only documents onListModels as the BYOK override path.',
    conclusion:
      'Without a client-level provider option, the probe scenario is not supported by the installed API shape; record the declaration evidence instead of attempting a live call.',
  };
}

export default {
  id: 'q10',
  slug: 'byok-list-models',
  description: 'Confirm whether the installed API shape supports listModels for session-level BYOK configuration.',
  requiresLive: false,
  maxEstimatedTokens: 0,
  run: runQ10,
};

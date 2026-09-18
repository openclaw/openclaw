/** Prepared Codex route, auth, and runtime plans shared by the compaction hook tests. */
export function createPreparedCodexCompactionPlans(modelId = "gpt-5.5") {
  const modelRoute = {
    provider: "openai",
    modelId,
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    authRequirement: "api-key",
    requestTransportOverrides: "none",
    runtimePolicy: { compatibleIds: ["codex"] },
  } as const;
  const runtimeAuthPlan = {
    providerForAuth: "openai",
    modelId,
    authProfileProviderForAuth: "openai",
    harnessAuthProvider: "openai",
    selectedAuthMode: "api-key",
    modelRoute,
  } as const;
  return {
    modelRoute,
    runtimeAuthPlan,
    runtimePlan: {
      resolvedRef: {
        provider: "openai",
        modelId,
        modelApi: "openai-responses",
        harnessId: "codex",
      },
      auth: runtimeAuthPlan,
    } as never,
  };
}

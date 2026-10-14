import { createMockProviderMap } from "./mock-model-config.js";
import type { QaProviderDefinition, QaProviderMode } from "./types.js";

type MockQaProviderDefinitionParams = {
  mode: Extract<QaProviderMode, "aimock" | "mock-openai">;
  commandDescription: string;
  serverLabel: string;
  mockAuthProviders: readonly string[];
};

export function createMockQaProviderDefinition(
  params: MockQaProviderDefinitionParams,
): QaProviderDefinition {
  return {
    mode: params.mode,
    kind: "mock",
    standaloneCommand: {
      name: params.mode,
      description: params.commandDescription,
      serverLabel: params.serverLabel,
    },
    defaultModel: (options) =>
      `${params.mode}/${options?.alternate ? "gpt-5.6-luna-alt" : "gpt-5.6-luna"}`,
    usesFastModeByDefault: () => false,
    resolveModelParams: () => ({
      transport: "sse",
      openaiWsWarmup: false,
    }),
    resolveTurnTimeoutMs: ({ fallbackMs }) => fallbackMs,
    buildGatewayModels: ({ providerBaseUrl, primaryModel, alternateModel }) => ({
      mode: "replace",
      providers: createMockProviderMap(params.mode, providerBaseUrl, [
        primaryModel,
        alternateModel,
      ]),
    }),
    mockAuthProviders: params.mockAuthProviders,
  };
}

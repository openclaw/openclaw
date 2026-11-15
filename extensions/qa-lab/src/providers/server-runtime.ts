import { getQaProvider, type QaMockProviderServer, type QaProviderModeInput } from "./index.js";
import type { QaMockOpenAiServerOptions } from "./mock-openai/server-options.js";

export async function startQaProviderServer(
  input: QaProviderModeInput,
  params?: QaMockOpenAiServerOptions,
): Promise<QaMockProviderServer | null> {
  const provider = getQaProvider(input);
  switch (provider.mode) {
    case "mock-openai": {
      const { startQaMockOpenAiServer } = await import("./mock-openai/server.js");
      return await startQaMockOpenAiServer(params);
    }
    case "aimock": {
      const { startQaAimockServer } = await import("./aimock/server.js");
      return await startQaAimockServer(params);
    }
    default:
      return null;
  }
}

import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import { readProviderField } from "./inference-provider-config.js";
import {
  releaseCodexProbeClient,
  type CodexAppServerClientOptions,
  type CodexAppServerClientFactory,
} from "./shared-client.js";
import type { CodexNativeWebSearchSupport } from "./web-search.js";

function resolveOverriddenProviderWebSearchSupport(
  modelProviderOverride: string | undefined,
): CodexNativeWebSearchSupport | undefined {
  const provider = modelProviderOverride?.trim().toLowerCase();
  if (!provider) {
    return undefined;
  }
  return provider === "openai" ? "supported" : undefined;
}

export async function resolveCodexProviderWebSearchSupportForClient(params: {
  client: CodexAppServerClient;
  timeoutMs: number;
  modelProviderOverride: string | undefined;
  expectedNativeModelProvider?: string;
  signal: AbortSignal;
}): Promise<CodexNativeWebSearchSupport> {
  const overrideSupport = resolveOverriddenProviderWebSearchSupport(params.modelProviderOverride);
  if (overrideSupport) {
    return overrideSupport;
  }
  try {
    const options = { timeoutMs: params.timeoutMs, signal: params.signal };
    const expectedProvider =
      params.modelProviderOverride?.trim() || params.expectedNativeModelProvider;
    let standalone = false;
    if (expectedProvider) {
      // The capability RPC describes the configured provider, not a persisted thread.
      const configured = await params.client.request(
        "config/read",
        { includeLayers: false },
        options,
      );
      if ((configured.config.model_provider ?? "openai") !== expectedProvider) {
        return "unknown";
      }
      if (expectedProvider !== "openai") {
        standalone =
          readProviderField(
            configured.config,
            expectedProvider,
            "supports_standalone_web_search",
          ) === true;
        if (!standalone) {
          return "unsupported";
        }
      }
    }
    const response = await params.client.request("modelProvider/capabilities/read", {}, options);
    return response.webSearch ? (standalone ? "standalone" : "supported") : "unsupported";
  } catch {
    return "unknown";
  }
}

export async function resolveCodexProviderWebSearchSupport(params: {
  clientFactory: CodexAppServerClientFactory;
  appServer: CodexAppServerRuntimeOptions;
  authProfileId: string | null | undefined;
  preparedAuth?: CodexAppServerClientOptions["preparedAuth"];
  agentDir: string;
  config: EmbeddedRunAttemptParams["config"] | undefined;
  modelProviderOverride: string | undefined;
  expectedNativeModelProvider?: string;
  signal: AbortSignal;
}): Promise<CodexNativeWebSearchSupport> {
  const overrideSupport = resolveOverriddenProviderWebSearchSupport(params.modelProviderOverride);
  if (overrideSupport) {
    // Never serialize the prewarmed app-server startup behind a capability
    // probe whose answer is already fixed by the selected thread provider.
    return overrideSupport;
  }
  let client: CodexAppServerClient | undefined;
  try {
    client = await params.clientFactory({
      startOptions: params.appServer.start,
      ...(params.preparedAuth
        ? { preparedAuth: params.preparedAuth }
        : { authProfileId: params.authProfileId }),
      agentDir: params.agentDir,
      config: params.config,
      timeoutMs: params.appServer.requestTimeoutMs,
    });
    return await resolveCodexProviderWebSearchSupportForClient({
      client,
      timeoutMs: params.appServer.requestTimeoutMs,
      modelProviderOverride: params.modelProviderOverride,
      expectedNativeModelProvider: params.expectedNativeModelProvider,
      signal: params.signal,
    });
  } catch {
    return "unknown";
  } finally {
    if (client) {
      await releaseCodexProbeClient(client, params.clientFactory);
    }
  }
}

import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerClientFactory } from "./client-factory.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import { releaseLeasedSharedCodexAppServerClient } from "./shared-client.js";
import type { CodexNativeWebSearchSupport } from "./web-search.js";

async function readConfiguredProviderWebSearchSupport(params: {
  client: CodexAppServerClient;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<CodexNativeWebSearchSupport> {
  const response = await params.client.request(
    "modelProvider/capabilities/read",
    {},
    {
      timeoutMs: params.timeoutMs,
      signal: params.signal,
    },
  );
  return response.webSearch ? "supported" : "unsupported";
}

function resolveProviderOverrideWebSearchSupport(
  modelProviderOverride: string | undefined,
): CodexNativeWebSearchSupport | undefined {
  const normalizedProvider = modelProviderOverride?.trim().toLowerCase();
  if (!normalizedProvider) {
    return undefined;
  }
  if (normalizedProvider === "openai") {
    return "supported";
  }

  // Codex's capability RPC only reports the configured provider, not a
  // thread-scoped override. Keep managed search for overrides whose hosted
  // capability cannot be proven from the configured-provider response.
  return "unsupported";
}

export async function resolveCodexProviderWebSearchSupportForClient(params: {
  client: CodexAppServerClient;
  timeoutMs: number;
  modelProviderOverride: string | undefined;
  signal: AbortSignal;
}): Promise<CodexNativeWebSearchSupport> {
  const providerOverrideSupport = resolveProviderOverrideWebSearchSupport(
    params.modelProviderOverride,
  );
  if (providerOverrideSupport !== undefined) {
    return providerOverrideSupport;
  }
  try {
    return await readConfiguredProviderWebSearchSupport(params);
  } catch {
    return "unknown";
  }
}

export async function resolveCodexProviderWebSearchSupport(params: {
  clientFactory: CodexAppServerClientFactory;
  appServer: CodexAppServerRuntimeOptions;
  authProfileId: string | undefined;
  agentDir: string;
  config: EmbeddedRunAttemptParams["config"] | undefined;
  modelProviderOverride: string | undefined;
  signal: AbortSignal;
}): Promise<CodexNativeWebSearchSupport> {
  const providerOverrideSupport = resolveProviderOverrideWebSearchSupport(
    params.modelProviderOverride,
  );
  if (providerOverrideSupport !== undefined) {
    return providerOverrideSupport;
  }

  let client: CodexAppServerClient | undefined;
  try {
    client = await params.clientFactory(
      params.appServer.start,
      params.authProfileId,
      params.agentDir,
      params.config,
      { timeoutMs: params.appServer.requestTimeoutMs },
    );
    return await resolveCodexProviderWebSearchSupportForClient({
      client,
      timeoutMs: params.appServer.requestTimeoutMs,
      modelProviderOverride: undefined,
      signal: params.signal,
    });
  } catch {
    return "unknown";
  } finally {
    if (client) {
      releaseLeasedSharedCodexAppServerClient(client);
    }
  }
}

import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAppServerClientFactory } from "./client-factory.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerRuntimeOptions } from "./config.js";
import { releaseLeasedSharedCodexAppServerClient } from "./shared-client.js";

async function readConfiguredProviderWebSearchSupport(params: {
  client: CodexAppServerClient;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<boolean> {
  const response = await params.client.request(
    "modelProvider/capabilities/read",
    {},
    {
      timeoutMs: params.timeoutMs,
      signal: params.signal,
    },
  );
  return response.webSearch;
}

export async function resolveCodexProviderWebSearchSupportForClient(params: {
  client: CodexAppServerClient;
  timeoutMs: number;
  modelProviderOverride: string | undefined;
  signal: AbortSignal;
}): Promise<boolean> {
  const modelProviderOverride = params.modelProviderOverride?.trim().toLowerCase();
  if (modelProviderOverride && modelProviderOverride !== "openai") {
    // Codex's capability RPC only reports the configured provider, not a
    // thread-scoped override. Keep managed search unless the override is the
    // built-in OpenAI provider whose hosted-search capability is being queried.
    return false;
  }
  try {
    return await readConfiguredProviderWebSearchSupport(params);
  } catch {
    return false;
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
}): Promise<boolean> {
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
      modelProviderOverride: params.modelProviderOverride,
      signal: params.signal,
    });
  } catch {
    return false;
  } finally {
    if (client) {
      releaseLeasedSharedCodexAppServerClient(client);
    }
  }
}

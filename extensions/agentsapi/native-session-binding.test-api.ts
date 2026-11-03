import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import * as providerAuth from "openclaw/plugin-sdk/provider-auth-runtime";
import { vi } from "vitest";
import { AgentsApiClient } from "./agentsapi-client.js";
import { createAgentsApiHarness } from "./agentsapi-harness.js";
import { createHostedSession } from "./agentsapi.test-support.js";

/** Real plugin and binding owners; native settlement is already idle in storage-only tests. */
export function createNativeBindingDeletionFixture(
  runtime: PluginRuntime,
  session: { sessionId: string },
) {
  const store = runtime.state.openSyncKeyedStore<Record<string, unknown>>({
    namespace: "agentsapi-sessions",
    maxEntries: 100_000,
    overflowPolicy: "reject-new",
  });
  const key = session.sessionId;
  vi.spyOn(providerAuth, "resolveApiKeyForProvider").mockResolvedValue({
    mode: "api-key",
    apiKey: "synthetic-native-binding-api-key",
    source: "fixture",
  });
  vi.spyOn(AgentsApiClient.prototype, "session").mockResolvedValue({
    ...createHostedSession("idle"),
    id: "synthetic-agentsapi-session",
  });
  store.register(key, {
    sessionId: "synthetic-agentsapi-session",
    configFingerprint: "synthetic-fingerprint",
  });
  return { key, store, harness: createAgentsApiHarness(runtime) };
}

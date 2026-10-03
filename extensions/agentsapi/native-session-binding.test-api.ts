import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { createAgentsApiHarness } from "./agentsapi-harness.js";

/** Real plugin owner; provider execution is unnecessary for deleting a persisted binding. */
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
  store.register(key, {
    sessionId: "synthetic-agentsapi-session",
    configFingerprint: "synthetic-fingerprint",
  });
  return { key, store, harness: createAgentsApiHarness(runtime) };
}

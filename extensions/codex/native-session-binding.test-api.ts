import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { vi } from "vitest";
import { createCodexAppServerAgentHarness } from "./harness.js";
import {
  ensureCodexAppServerClientRuntime,
  hasCodexAppServerLiveThread,
} from "./src/app-server/client-runtime.js";
import {
  CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
  CODEX_APP_SERVER_BINDING_NAMESPACE,
} from "./src/app-server/session-binding-meta.js";
import {
  bindingStoreKey,
  createCodexAppServerBindingStore,
  readStoredCodexAppServerBinding,
} from "./src/app-server/session-binding.js";
import { createCodexRuntimeTestBindingStateStore } from "./src/app-server/session-binding.sqlite.test-helpers.js";
import * as sharedClients from "./src/app-server/shared-client.js";
import { createClientHarness } from "./src/app-server/test-support.js";
import { retainCodexAppServerBindingSubscription } from "./src/app-server/thread-ownership.js";

/** Real plugin owner for the host's compound deletion and released-adapter comparisons. */
export function createNativeBindingDeletionFixture(
  runtime: PluginRuntime,
  session: { agentId: string; sessionId: string; sessionKey: string },
) {
  const options = {
    namespace: CODEX_APP_SERVER_BINDING_NAMESPACE,
    maxEntries: CODEX_APP_SERVER_BINDING_MAX_ENTRIES,
    overflowPolicy: "reject-new" as const,
  };
  const store = runtime.state.openSyncKeyedStore<Record<string, unknown>>(options);
  const bindingStore = createCodexAppServerBindingStore(
    createCodexRuntimeTestBindingStateStore(runtime, options),
  );
  const key = bindingStoreKey({ kind: "session", ...session });
  store.register(key, {
    version: 1,
    state: "active",
    sessionId: session.sessionId,
    binding: { threadId: "synthetic-codex-thread", cwd: "/synthetic/workspace" },
    nativeSubagentTaskImport: { version: 99, opaque: ["retain", { nested: true }] },
  });
  return { key, store, harness: createCodexAppServerAgentHarness({ runtime, bindingStore }) };
}

/** Attach the same exact-client custody fixture used by native retirement tests, without a provider. */
export async function attachNativeBindingDeletionClient(
  store: PluginStateSyncKeyedStore<Record<string, unknown>>,
  key: string,
) {
  const stored = readStoredCodexAppServerBinding(store.lookup(key));
  if (stored?.state !== "active") {
    throw new Error("Expected the fixture's active Codex binding");
  }
  const harness = createClientHarness();
  const { client } = harness;
  const binding = { ...stored.binding, clientId: client.getInstanceId() };
  const release = vi.fn();
  const request = vi.spyOn(client, "request").mockResolvedValue({ status: "unsubscribed" });
  vi.spyOn(sharedClients, "retainSharedCodexAppServerClientByInstanceId").mockImplementation(
    async (clientId) => (clientId === binding.clientId ? { client, release } : undefined),
  );
  ensureCodexAppServerClientRuntime(client, {
    agentDir: "/synthetic/native-binding-agent",
    authMode: "prepared-api-key",
  });
  store.register(key, { ...stored, binding });
  await retainCodexAppServerBindingSubscription(client, binding.threadId);
  return {
    release,
    request,
    subscribed: () => hasCodexAppServerLiveThread(client, binding.threadId),
    close() {
      client.close();
      harness.emitExit();
    },
  };
}

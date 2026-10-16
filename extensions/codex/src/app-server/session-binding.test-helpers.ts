export * from "./session-binding.js";
import type { inspectConversationBinding } from "openclaw/plugin-sdk/conversation-binding-inspection-runtime";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { legacyCodexConversationBindingId } from "../conversation-binding-data.js";
import {
  readCodexPluginConfig,
  resolveCodexSupervisionAppServerRuntimeOptions as supervisionOptions,
} from "./config.js";
import { buildCodexAppServerConnectionFingerprint as connectionFingerprint } from "./plugin-app-cache-key.js";
import {
  bindingStoreKey,
  createCodexAppServerBindingStore as createBindingStore,
  type CodexAppServerBindingStore as BindingStore,
  type CodexAppServerThreadBinding as ThreadBinding,
  type CodexBindingStateStore,
  type StoredCodexAppServerBinding as StoredBinding,
} from "./session-binding.js";

export function createCodexTestBindingStateStore(
  values = new Map<string, StoredBinding>(),
): Pick<PluginStateSyncKeyedStore<StoredBinding>, "register" | "lookup" | "delete" | "clear"> &
  CodexBindingStateStore {
  const observe = (key: string) => ({
    value: structuredClone(values.get(key)),
    comparison: JSON.stringify([key, values.get(key)]),
  });
  return {
    asyncReads: {
      lookup: async (key) => values.get(key),
      lookupMany: async (keys) => keys.map((key) => ({ ok: true, value: values.get(key) })),
      entries: async () => [...values].map(([key, value]) => ({ key, value, createdAt: 0 })),
    },
    withCurrent({ assertCurrent }) {
      assertCurrent();
      return {
        async observe(key) {
          assertCurrent();
          return observe(key);
        },
        async compareAndApply(key, comparison, intent) {
          assertCurrent();
          const current = observe(key);
          if (current.comparison !== comparison) {
            return { status: "conflict", current };
          }
          if (intent.action === "keep") {
            return { status: "unchanged" };
          }
          if (intent.operation === "delete") {
            return { status: values.delete(key) ? "applied" : "unchanged" };
          }
          values.set(key, structuredClone(intent.value));
          return { status: "applied" };
        },
      };
    },
    register(key, value) {
      values.set(key, value);
    },
    lookup: (key) => values.get(key),
    delete: (key) => values.delete(key),
    clear: () => values.clear(),
  };
}

export function createCodexTestBindingStore(): BindingStore {
  return createBindingStore(createCodexTestBindingStateStore());
}

export function buildCodexSupervisionTestConnectionFingerprint(
  pluginConfig: unknown = { supervision: { enabled: true } },
): string {
  return connectionFingerprint(
    supervisionOptions({
      pluginConfig: readCodexPluginConfig(pluginConfig),
      env: {},
      requirementsToml: null,
    }),
  );
}

const sharedStateStore = createCodexTestBindingStateStore();
export const testCodexAppServerBindingStore = createBindingStore(sharedStateStore);
const testSessionIdentities = new Map<
  string,
  { agentId: string; sessionId: string; sessionKey?: string }
>();

export function resetCodexTestBindingStore(): void {
  sharedStateStore.clear();
  testSessionIdentities.clear();
}

export function registerCodexTestSessionIdentity(
  locator: string,
  sessionId: string,
  sessionKey?: string,
  agentId = "main",
): void {
  const previousKey = bindingStoreKey(testIdentity(locator));
  testSessionIdentities.set(locator, {
    agentId,
    sessionId,
    ...(sessionKey ? { sessionKey } : {}),
  });
  const nextKey = bindingStoreKey(testIdentity(locator));
  if (previousKey !== nextKey) {
    const value = sharedStateStore.lookup(previousKey);
    if (value) {
      sharedStateStore.register(nextKey, { ...value, sessionId });
      sharedStateStore.delete(previousKey);
    }
  }
}

export function seedCodexTestBinding(locator: string, binding: ThreadBinding): void {
  sharedStateStore.register(bindingStoreKey(testIdentity(locator)), {
    version: 1,
    state: "active",
    binding,
  });
}

function testIdentity(locator: string) {
  return {
    kind: "session" as const,
    ...(testSessionIdentities.get(locator) ?? { agentId: "main", sessionId: locator }),
  };
}

function bindingAccessors(
  identity: (locator: string) => Parameters<BindingStore["read"]>[0],
  defaults: Partial<ThreadBinding> = {},
) {
  return {
    read: async (locator: string, _lookup?: unknown) =>
      testCodexAppServerBindingStore.read(identity(locator)),
    write: async (locator: string, binding: ThreadBinding, _lookup?: unknown) => {
      await testCodexAppServerBindingStore.mutate(identity(locator), {
        kind: "set",
        binding: { ...defaults, ...binding },
      });
    },
    clear: async (locator: string, threadId: string) =>
      testCodexAppServerBindingStore.mutate(identity(locator), { kind: "clear", threadId }),
  };
}

export const {
  read: readCodexAppServerBinding,
  write: writeCodexAppServerBinding,
  clear: clearCodexAppServerBindingForThread,
} = bindingAccessors(testIdentity);

export function createCodexTestContextEngineBinding() {
  return {
    schemaVersion: 1 as const,
    engineId: "lossless-claw",
    policyFingerprint: "policy-1",
    projection: {
      schemaVersion: 1 as const,
      mode: "thread_bootstrap" as const,
      epoch: "epoch-1",
      fingerprint: "fingerprint-1",
    },
  };
}

export function testConversationIdentity(sessionFile: string) {
  return {
    kind: "conversation" as const,
    bindingId: legacyCodexConversationBindingId(sessionFile),
  };
}

export const { read: readTestConversationBinding, write: writeTestConversationBinding } =
  bindingAccessors(testConversationIdentity, { clientId: "test-client" });

export function createConversationInspection(
  conversation: Parameters<typeof inspectConversationBinding>[0],
  bindingId: string | undefined,
): ReturnType<typeof inspectConversationBinding> {
  return {
    status: "available",
    binding: bindingId
      ? {
          bindingId,
          targetSessionKey: "agent:main:codex-bound-test",
          targetKind: "session",
          conversation,
          status: "active",
          boundAt: 1,
        }
      : null,
  };
}

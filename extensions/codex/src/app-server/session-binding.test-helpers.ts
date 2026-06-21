/** In-memory binding store helpers for Codex app-server tests. */
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  bindingStoreKey,
  createCodexAppServerBindingStore,
  type CodexAppServerBindingStore,
  type CodexAppServerThreadBinding,
  type StoredCodexAppServerBinding,
} from "./session-binding.js";

export function createCodexTestBindingStateStore(): PluginStateSyncKeyedStore<StoredCodexAppServerBinding> {
  const values = new Map<string, StoredCodexAppServerBinding>();
  return {
    register(key, value) {
      values.set(key, value);
    },
    registerIfAbsent(key, value) {
      if (values.has(key)) {
        return false;
      }
      values.set(key, value);
      return true;
    },
    update(key, updateValue) {
      const next = updateValue(values.get(key));
      if (next === undefined) {
        return false;
      }
      values.set(key, next);
      return true;
    },
    lookup: (key) => values.get(key),
    consume(key) {
      const value = values.get(key);
      values.delete(key);
      return value;
    },
    delete: (key) => values.delete(key),
    entries: () => [...values].map(([key, value]) => ({ key, value, createdAt: 0 })),
    clear: () => values.clear(),
  };
}

export function createCodexTestBindingStore(): CodexAppServerBindingStore {
  return createCodexAppServerBindingStore(createCodexTestBindingStateStore());
}

const sharedStateStore = createCodexTestBindingStateStore();
export const testCodexAppServerBindingStore = createCodexAppServerBindingStore(sharedStateStore);
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
  testSessionIdentities.set(locator, {
    agentId,
    sessionId,
    ...(sessionKey ? { sessionKey } : {}),
  });
}

export function seedCodexTestBinding(locator: string, binding: CodexAppServerThreadBinding): void {
  sharedStateStore.register(bindingStoreKey(testIdentity(locator)), {
    version: 1,
    state: "active",
    binding,
  });
}

function testIdentity(locator: string) {
  const identity = testSessionIdentities.get(locator);
  return {
    kind: "session" as const,
    agentId: identity?.agentId ?? "main",
    sessionId: identity?.sessionId ?? locator,
    ...(identity?.sessionKey ? { sessionKey: identity.sessionKey } : {}),
  };
}

export async function readCodexAppServerBinding(
  sessionId: string,
): Promise<CodexAppServerThreadBinding | undefined> {
  return await testCodexAppServerBindingStore.read(testIdentity(sessionId));
}

export async function writeCodexAppServerBinding(
  sessionId: string,
  binding: CodexAppServerThreadBinding,
): Promise<void> {
  await testCodexAppServerBindingStore.mutate(testIdentity(sessionId), { kind: "set", binding });
}

export async function clearCodexAppServerBinding(sessionId: string): Promise<void> {
  await testCodexAppServerBindingStore.mutate(testIdentity(sessionId), { kind: "clear" });
}

export async function clearCodexAppServerBindingForThread(
  sessionId: string,
  threadId: string,
): Promise<boolean> {
  return await testCodexAppServerBindingStore.mutate(testIdentity(sessionId), {
    kind: "clear",
    threadId,
  });
}

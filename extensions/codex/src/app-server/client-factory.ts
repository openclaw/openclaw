import { AsyncLocalStorage } from "node:async_hooks";
import type { resolveCodexAppServerAuthProfileIdForAgent } from "./auth-bridge.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config.js";

type AuthProfileOrderConfig = Parameters<
  typeof resolveCodexAppServerAuthProfileIdForAgent
>[0]["config"];

export type CodexAppServerClientFactory = (
  startOptions?: CodexAppServerStartOptions,
  authProfileId?: string,
  agentDir?: string,
  config?: AuthProfileOrderConfig,
) => Promise<CodexAppServerClient>;

export const defaultCodexAppServerClientFactory: CodexAppServerClientFactory = (
  startOptions,
  authProfileId,
  agentDir,
  config,
) =>
  import("./shared-client.js").then(({ getSharedCodexAppServerClient }) =>
    getSharedCodexAppServerClient({ startOptions, authProfileId, agentDir, config }),
  );

// Keep test-only overrides outside run-attempt.ts so re-entrant ESM evaluation
// cannot touch run-attempt module-scope bindings before initialization.
const testClientFactoryStorage = new AsyncLocalStorage<CodexAppServerClientFactory | undefined>();

export function resolveCodexAppServerClientFactory(): CodexAppServerClientFactory {
  return testClientFactoryStorage.getStore() ?? defaultCodexAppServerClientFactory;
}

export function setCodexAppServerClientFactoryForTests(
  factory: CodexAppServerClientFactory,
): void {
  testClientFactoryStorage.enterWith(factory);
}

export function resetCodexAppServerClientFactoryForTests(): void {
  testClientFactoryStorage.enterWith(undefined);
}

export function createCodexAppServerClientFactoryTestHooks(
  setFactory: (factory: CodexAppServerClientFactory) => void,
) {
  return {
    setCodexAppServerClientFactoryForTests(factory: CodexAppServerClientFactory): void {
      setFactory(factory);
    },
    resetCodexAppServerClientFactoryForTests(): void {
      setFactory(defaultCodexAppServerClientFactory);
    },
  } as const;
}

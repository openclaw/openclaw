import { resolveOpenClawAgentDir } from "openclaw/plugin-sdk/provider-auth";
import { applyCodexAppServerAuthProfile, bridgeCodexAppServerStartOptions } from "./auth-bridge.js";
import { CodexAppServerClient } from "./client.js";
import {
  codexAppServerStartOptionsKey,
  resolveCodexAppServerRuntimeOptions,
  type CodexAppServerStartOptions,
} from "./config.js";
import { resolveManagedCodexAppServerStartOptions } from "./managed-binary.js";
import { withTimeout } from "./timeout.js";

type SharedCodexAppServerClientState = {
  client?: CodexAppServerClient;
  promise?: Promise<CodexAppServerClient>;
  key?: string;
};

const SHARED_CODEX_APP_SERVER_CLIENT_STATE = Symbol.for("openclaw.codexAppServerClientState");

function getSharedCodexAppServerClientState(): SharedCodexAppServerClientState {
  const globalState = globalThis as typeof globalThis & {
    [SHARED_CODEX_APP_SERVER_CLIENT_STATE]?: SharedCodexAppServerClientState;
  };
  globalState[SHARED_CODEX_APP_SERVER_CLIENT_STATE] ??= {};
  return globalState[SHARED_CODEX_APP_SERVER_CLIENT_STATE];
}

export async function getSharedCodexAppServerClient(options?: {
  startOptions?: CodexAppServerStartOptions;
  timeoutMs?: number;
  authProfileId?: string;
  agentDir?: string;
}): Promise<CodexAppServerClient> {
  const state = getSharedCodexAppServerClientState();
  const agentDir = options?.agentDir ?? resolveOpenClawAgentDir();
  const requestedStartOptions =
    options?.startOptions ?? resolveCodexAppServerRuntimeOptions().start;
  const managedStartOptions = await resolveManagedCodexAppServerStartOptions(requestedStartOptions);
  const startOptions = await bridgeCodexAppServerStartOptions({
    startOptions: managedStartOptions,
    agentDir,
    authProfileId: options?.authProfileId,
  });
  const key = codexAppServerStartOptionsKey(startOptions, {
    authProfileId: options?.authProfileId,
    agentDir,
  });
  if (state.key && state.key !== key) {
    clearSharedCodexAppServerClient();
  }
  state.key = key;
  const sharedPromise =
    state.promise ??
    (state.promise = (async () => {
      const client = CodexAppServerClient.start(startOptions);
      state.client = client;
      client.addCloseHandler(clearSharedClientIfCurrent);
      try {
        await client.initialize();
        await applyCodexAppServerAuthProfile({
          client,
          agentDir,
          authProfileId: options?.authProfileId,
          startOptions,
        });
        return client;
      } catch (error) {
        // Startup failures happen before callers own the shared client, so close
        // the child here instead of leaving a rejected daemon attached to stdio.
        client.close();
        throw error;
      }
    })());
  try {
    return await withTimeout(
      sharedPromise,
      options?.timeoutMs ?? 0,
      "codex app-server initialize timed out",
    );
  } catch (error) {
    if (state.promise === sharedPromise && state.key === key) {
      clearSharedCodexAppServerClient();
    }
    throw error;
  }
}

export async function createIsolatedCodexAppServerClient(options?: {
  startOptions?: CodexAppServerStartOptions;
  timeoutMs?: number;
  authProfileId?: string;
  signal?: AbortSignal;
  agentDir?: string;
}): Promise<CodexAppServerClient> {
  const agentDir = options?.agentDir ?? resolveOpenClawAgentDir();
  const requestedStartOptions =
    options?.startOptions ?? resolveCodexAppServerRuntimeOptions().start;
  const managedStartOptions = await resolveManagedCodexAppServerStartOptions(requestedStartOptions);
  const startOptions = await bridgeCodexAppServerStartOptions({
    startOptions: managedStartOptions,
    agentDir,
    authProfileId: options?.authProfileId,
  });
  const client = CodexAppServerClient.start(startOptions);
  const initialize = client.initialize();
  const abortMessage = "codex app-server initialize aborted";
  try {
    const abortable = options?.signal
      ? withAbortSignal(
          withTimeout(initialize, options?.timeoutMs ?? 0, "codex app-server initialize timed out"),
          options.signal,
          abortMessage,
        )
      : withTimeout(initialize, options?.timeoutMs ?? 0, "codex app-server initialize timed out");
    await abortable;
    await withAbortSignal(
      applyCodexAppServerAuthProfile({
        client,
        agentDir,
        authProfileId: options?.authProfileId,
        startOptions,
      }),
      options?.signal,
      abortMessage,
    );
    return client;
  } catch (error) {
    client.close();
    void initialize.catch(() => undefined);
    throw error;
  }
}

async function withAbortSignal<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  abortMessage: string,
): Promise<T> {
  if (!signal) {
    return await promise;
  }
  if (signal.aborted) {
    throw new Error(abortMessage);
  }
  let cleanup: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        const abortListener = () => reject(new Error(abortMessage));
        signal.addEventListener("abort", abortListener, { once: true });
        cleanup = () => signal.removeEventListener("abort", abortListener);
      }),
    ]);
  } finally {
    cleanup?.();
  }
}

export function resetSharedCodexAppServerClientForTests(): void {
  const state = getSharedCodexAppServerClientState();
  state.client = undefined;
  state.promise = undefined;
  state.key = undefined;
}

export function clearSharedCodexAppServerClient(): void {
  const state = getSharedCodexAppServerClientState();
  const client = state.client;
  state.client = undefined;
  state.promise = undefined;
  state.key = undefined;
  client?.close();
}

export function clearSharedCodexAppServerClientIfCurrent(
  client: CodexAppServerClient | undefined,
): boolean {
  if (!client) {
    return false;
  }
  const state = getSharedCodexAppServerClientState();
  if (state.client !== client) {
    return false;
  }
  state.client = undefined;
  state.promise = undefined;
  state.key = undefined;
  client.close();
  return true;
}

export async function clearSharedCodexAppServerClientAndWait(options?: {
  exitTimeoutMs?: number;
  forceKillDelayMs?: number;
}): Promise<void> {
  const state = getSharedCodexAppServerClientState();
  const client = state.client;
  state.client = undefined;
  state.promise = undefined;
  state.key = undefined;
  await client?.closeAndWait(options);
}

function clearSharedClientIfCurrent(client: CodexAppServerClient): void {
  const state = getSharedCodexAppServerClientState();
  if (state.client !== client) {
    return;
  }
  state.client = undefined;
  state.promise = undefined;
  state.key = undefined;
}

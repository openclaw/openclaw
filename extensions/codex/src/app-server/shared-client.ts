import { resolveDefaultAgentDir } from "openclaw/plugin-sdk/agent-runtime";
import {
  applyCodexAppServerAuthProfile,
  bridgeCodexAppServerStartOptions,
  resolveCodexAppServerAuthProfileIdForAgent,
} from "./auth-bridge.js";
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
  leases?: WeakMap<CodexAppServerClient, number>;
  retireWhenIdle?: WeakSet<CodexAppServerClient>;
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
  authProfileId?: string | null;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
}): Promise<CodexAppServerClient> {
  const state = getSharedCodexAppServerClientState();
  const agentDir = options?.agentDir ?? resolveDefaultAgentDir(options?.config ?? {});
  const usesNativeAuth = options?.authProfileId === null;
  const requestedAuthProfileId =
    options?.authProfileId === null ? undefined : options?.authProfileId;
  const authProfileId = usesNativeAuth
    ? undefined
    : resolveCodexAppServerAuthProfileIdForAgent({
        authProfileId: requestedAuthProfileId,
        agentDir,
        config: options?.config,
      });
  const requestedStartOptions =
    options?.startOptions ?? resolveCodexAppServerRuntimeOptions().start;
  const managedStartOptions = await resolveManagedCodexAppServerStartOptions(requestedStartOptions);
  const startOptions = await bridgeCodexAppServerStartOptions({
    startOptions: managedStartOptions,
    agentDir,
    authProfileId: usesNativeAuth ? null : authProfileId,
    config: options?.config,
  });
  const key = codexAppServerStartOptionsKey(startOptions, {
    authProfileId,
    agentDir: usesNativeAuth ? undefined : agentDir,
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
          authProfileId: usesNativeAuth ? null : authProfileId,
          startOptions,
          config: options?.config,
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
  authProfileId?: string | null;
  agentDir?: string;
  config?: Parameters<typeof resolveCodexAppServerAuthProfileIdForAgent>[0]["config"];
}): Promise<CodexAppServerClient> {
  const agentDir = options?.agentDir ?? resolveDefaultAgentDir(options?.config ?? {});
  const usesNativeAuth = options?.authProfileId === null;
  const requestedAuthProfileId =
    options?.authProfileId === null ? undefined : options?.authProfileId;
  const authProfileId = usesNativeAuth
    ? undefined
    : resolveCodexAppServerAuthProfileIdForAgent({
        authProfileId: requestedAuthProfileId,
        agentDir,
        config: options?.config,
      });
  const requestedStartOptions =
    options?.startOptions ?? resolveCodexAppServerRuntimeOptions().start;
  const managedStartOptions = await resolveManagedCodexAppServerStartOptions(requestedStartOptions);
  const startOptions = await bridgeCodexAppServerStartOptions({
    startOptions: managedStartOptions,
    agentDir,
    authProfileId: usesNativeAuth ? null : authProfileId,
    config: options?.config,
  });
  const client = CodexAppServerClient.start(startOptions);
  const initialize = client.initialize();
  try {
    await withTimeout(initialize, options?.timeoutMs ?? 0, "codex app-server initialize timed out");
    await applyCodexAppServerAuthProfile({
      client,
      agentDir,
      authProfileId: usesNativeAuth ? null : authProfileId,
      startOptions,
      config: options?.config,
    });
    return client;
  } catch (error) {
    client.close();
    void initialize.catch(() => undefined);
    throw error;
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
  if (client) {
    state.leases?.delete(client);
    state.retireWhenIdle?.delete(client);
  }
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
  state.leases?.delete(client);
  state.retireWhenIdle?.delete(client);
  client.close();
  return true;
}

export function retainSharedCodexAppServerClient(
  client: CodexAppServerClient | undefined,
): () => void {
  if (!client) {
    return () => undefined;
  }
  const state = getSharedCodexAppServerClientState();
  if (state.client !== client) {
    return () => undefined;
  }
  state.leases ??= new WeakMap();
  state.retireWhenIdle ??= new WeakSet();
  state.leases.set(client, (state.leases.get(client) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const currentCount = state.leases?.get(client) ?? 0;
    if (currentCount <= 1) {
      state.leases?.delete(client);
      if (state.retireWhenIdle?.has(client)) {
        state.retireWhenIdle.delete(client);
        closeCodexAppServerClientIfAvailable(client);
      }
      return;
    }
    state.leases?.set(client, currentCount - 1);
  };
}

export function retireSharedCodexAppServerClient(client: CodexAppServerClient | undefined): {
  clearedSharedClient: boolean;
  closedClient: boolean;
  deferredSharedClientRetirement: boolean;
} {
  if (!client) {
    return {
      clearedSharedClient: false,
      closedClient: false,
      deferredSharedClientRetirement: false,
    };
  }
  const state = getSharedCodexAppServerClientState();
  const leaseCount = state.leases?.get(client) ?? 0;
  const deferClose = leaseCount > 0;
  if (state.client === client) {
    state.client = undefined;
    state.promise = undefined;
    state.key = undefined;
    if (deferClose) {
      state.retireWhenIdle ??= new WeakSet();
      state.retireWhenIdle.add(client);
      return {
        clearedSharedClient: true,
        closedClient: false,
        deferredSharedClientRetirement: true,
      };
    }
    const closedClient = closeCodexAppServerClientIfAvailable(client);
    return {
      clearedSharedClient: true,
      closedClient,
      deferredSharedClientRetirement: false,
    };
  }
  if (deferClose) {
    state.retireWhenIdle ??= new WeakSet();
    state.retireWhenIdle.add(client);
    return {
      clearedSharedClient: false,
      closedClient: false,
      deferredSharedClientRetirement: true,
    };
  }
  const closedClient = closeCodexAppServerClientIfAvailable(client);
  return {
    clearedSharedClient: false,
    closedClient,
    deferredSharedClientRetirement: false,
  };
}

function closeCodexAppServerClientIfAvailable(client: CodexAppServerClient): boolean {
  const close = (client as { close?: () => void }).close;
  if (typeof close !== "function") {
    return false;
  }
  close.call(client);
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
  if (client) {
    state.leases?.delete(client);
    state.retireWhenIdle?.delete(client);
  }
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

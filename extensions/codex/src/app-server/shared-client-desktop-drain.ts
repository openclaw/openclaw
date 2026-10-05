import path from "node:path";
import { resolveDefaultAgentDir } from "openclaw/plugin-sdk/agent-harness-registration";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveCodexAppServerHomeDir } from "./auth-bridge.js";
import { resolveCodexAppServerUserHomeDir } from "./auth-start-options.js";
import { withCodexAppServerAcquireDeadline } from "./client-startup-retry.js";
import { CodexAppServerClient } from "./client.js";
import type { CodexAppServerStartOptions } from "./config-contracts.js";
import type { CodexDesktopGeneration } from "./desktop-generation-owner.js";
import {
  getSharedCodexAppServerClientState,
  type SharedCodexAppServerClientState,
} from "./shared-client-lifecycle.js";
import type { CodexAppServerClientOptions } from "./shared-client.js";
export function readCodexAppServerClientDesktopGenerationFingerprint(
  client: CodexAppServerClient,
): string | undefined {
  return readCodexAppServerClientDesktopGeneration(client)?.fingerprint;
}

export function readCodexAppServerClientDesktopGeneration(
  client: CodexAppServerClient,
): CodexDesktopGeneration | undefined {
  return getSharedCodexAppServerClientState().startMetadata.get(client)?.desktopGeneration;
}

/** Waits until older physical desktop clients for this client's Codex home exit. */
export async function waitForCodexAppServerClientDesktopGenerationDrain(params: {
  client: CodexAppServerClient;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<void> {
  const metadata = getSharedCodexAppServerClientState().startMetadata.get(params.client);
  if (!metadata?.desktopGeneration) {
    return;
  }
  const drain = createOlderDesktopGenerationDrainWait({
    generation: metadata.desktopGeneration,
    startOptions: metadata.startOptions,
    agentDir: metadata.agentDir,
  });
  try {
    await withCodexAppServerAcquireDeadline(
      params.timeoutMs ?? 0,
      drain.promise,
      params.signal,
      "Codex Computer Use install timed out waiting for older desktop clients",
    );
  } finally {
    drain.cancel();
  }
}

export function resolveCodexNativeConfigFenceKey(params: {
  client?: CodexAppServerClient;
  startOptions?: CodexAppServerStartOptions;
  agentDir?: string;
  config?: CodexAppServerClientOptions["config"];
}): string | undefined {
  const metadata = params.client
    ? getSharedCodexAppServerClientState().startMetadata.get(params.client)
    : undefined;
  const startOptions = metadata?.startOptions ?? params.startOptions;
  if (!startOptions || startOptions.transport !== "stdio") {
    return undefined;
  }
  const configuredHome = startOptions.codexHome ?? startOptions.env?.CODEX_HOME?.trim();
  const codexHome = configuredHome
    ? configuredHome
    : startOptions.homeScope === "user"
      ? resolveCodexAppServerUserHomeDir()
      : resolveCodexAppServerHomeDir(
          params.agentDir ?? metadata?.agentDir ?? resolveDefaultAgentDir(params.config ?? {}),
        );
  return codexHome ? `codex-home:${path.resolve(codexHome)}` : undefined;
}

export function createOlderDesktopGenerationDrainWait(params: {
  generation: CodexDesktopGeneration;
  startOptions: CodexAppServerStartOptions;
  agentDir?: string;
}): { promise: Promise<void>; cancel: () => void } {
  const targetHome = resolveCodexNativeConfigFenceKey({
    startOptions: params.startOptions,
    agentDir: params.agentDir,
  });
  if (!targetHome) {
    return { promise: Promise.resolve(), cancel: () => undefined };
  }
  const state = getSharedCodexAppServerClientState();
  const { promise, resolve: resolveWait } = createDeferred<void>();
  const cancel = () => {
    state.desktopGenerationDrainChecks.delete(check);
    resolveWait();
  };
  const check = () => {
    if (
      !hasLiveOlderDesktopGenerationClient({
        state,
        generation: params.generation,
        targetHome,
      })
    ) {
      cancel();
    }
  };
  state.desktopGenerationDrainChecks.add(check);
  check();
  return { promise, cancel };
}

function hasLiveOlderDesktopGenerationClient(params: {
  state: SharedCodexAppServerClientState;
  generation: CodexDesktopGeneration;
  targetHome: string;
}): boolean {
  for (const clients of [params.state.liveClients, params.state.isolatedClients]) {
    for (const client of clients) {
      const metadata = params.state.startMetadata.get(client);
      if (
        metadata?.desktopGeneration &&
        metadata.desktopGeneration.epoch < params.generation.epoch &&
        resolveCodexNativeConfigFenceKey({ client }) === params.targetHome
      ) {
        return true;
      }
    }
  }
  return false;
}

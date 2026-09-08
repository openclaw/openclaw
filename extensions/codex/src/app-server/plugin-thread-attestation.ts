/**
 * Checks app availability against the effective Codex thread policy.
 */
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
  unsubscribeCodexThreadBestEffort,
} from "./attempt-client-cleanup.js";
import type { CodexAppServerClient } from "./client.js";
import type { v2 } from "./protocol.js";

class CodexPluginThreadAppAttestationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CodexPluginThreadAppAttestationError";
  }
}

/** Reads the existing runtime snapshot with the started thread's effective app policy. */
export async function checkCodexThreadAppAvailability(params: {
  client: CodexAppServerClient;
  threadId: string;
  appIds: readonly string[];
  signal?: AbortSignal;
}): Promise<void> {
  const appIds = Array.from(new Set(params.appIds.filter(Boolean))).toSorted();
  if (appIds.length === 0) {
    return;
  }

  let response: v2.AppsInstalledResponse;
  try {
    response = await params.client.request(
      "app/installed",
      { threadId: params.threadId, forceRefresh: false },
      { signal: params.signal },
    );
  } catch (error) {
    params.signal?.throwIfAborted();
    throw new CodexPluginThreadAppAttestationError(
      `Codex could not confirm admitted apps for thread ${params.threadId}`,
      { cause: error },
    );
  }
  params.signal?.throwIfAborted();

  const installedById = new Map(response.apps.map((app) => [app.id, app] as const));
  const failures = appIds.flatMap((appId): string[] => {
    const app = installedById.get(appId);
    if (!app) {
      return [`${appId}:missing`];
    }
    if (!app.enabled) {
      return [`${appId}:disabled`];
    }
    return app.callable ? [] : [`${appId}:not-callable`];
  });
  if (failures.length > 0) {
    // Availability is not authorization: Codex still filters and checks each tool.
    // An optional app with no allowed tools must not prevent unrelated chat or heartbeats.
    embeddedAgentLog.warn("codex apps unavailable; continuing with remaining tools", {
      threadId: params.threadId,
      failures,
    });
  }
}

/** Deletes a persistent pre-turn thread; ephemeral threads can only be unsubscribed. */
export async function discardUnattestedCodexPluginThread(params: {
  client: CodexAppServerClient;
  threadId: string;
  ephemeral: boolean;
}): Promise<boolean> {
  if (params.ephemeral) {
    return await unsubscribeCodexThreadBestEffort(params.client, {
      threadId: params.threadId,
      timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
    });
  }

  try {
    await params.client.request(
      "thread/delete",
      { threadId: params.threadId },
      { timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS },
    );
    return true;
  } catch (error) {
    embeddedAgentLog.debug("codex plugin app attestation thread deletion failed", {
      threadId: params.threadId,
      error,
    });
    await unsubscribeCodexThreadBestEffort(params.client, {
      threadId: params.threadId,
      timeoutMs: CODEX_APP_SERVER_UNSUBSCRIBE_TIMEOUT_MS,
    });
    return false;
  }
}

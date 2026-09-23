import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-registration";
import type { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { resolveCodexAppServerLocalHomeDir } from "./app-server/auth-start-options.js";
import type { CodexAppServerClient, CodexAppServerRuntimeIdentity } from "./app-server/client.js";
import type { CodexAppServerStartOptions } from "./app-server/config-contracts.js";
import { inferCodexAppServerConnectionClass } from "./app-server/config-security.js";
import { buildCodexAppServerConnectionFingerprint } from "./app-server/plugin-app-cache-key.js";
import type { CodexServerNotification, CodexThread } from "./app-server/protocol.js";
import { defineCodexBuildState } from "./build-state.js";
import { codexCatalogHomeIdFromCanonicalPath } from "./session-catalog-home-id.js";
import { projectCodexCatalogNativeThread } from "./session-catalog-native-projection.js";
import {
  boundedCatalogString,
  MAX_CWD_LENGTH,
  MAX_SESSION_ID_LENGTH,
} from "./session-catalog-parsing.js";
import {
  codexCatalogSourceForClient,
  observeCodexCatalogEphemeralThreads,
  type CodexCatalogSource,
} from "./session-catalog-source.js";

type CodexCatalogEventListener = (
  event: CodexServerNotification,
  readThread: (threadId: string) => Promise<CodexThread>,
  source: CodexCatalogSource,
) => void;
type CodexCatalogResumeMetadata = {
  thread: CodexThread;
  cwd?: string | null;
  modelProvider?: string | null;
};
type CodexCatalogSubscription = {
  notify: CodexCatalogEventListener;
} & CodexCatalogLifecycleCallbacks;
type CodexCatalogLifecycleCallbacks = {
  onRemoteReady?: (source: CodexCatalogSource) => void;
  onClose?: (source: CodexCatalogSource) => void;
  onEphemeralThread?: (threadId: string) => void;
  onResume?: (response: CodexCatalogResumeMetadata, source: CodexCatalogSource) => Promise<void>;
};
type CodexCatalogClientBinding = { homeKey: string; source: CodexCatalogSource };

const getCatalogEvents = defineCodexBuildState("openclaw.codexCatalogEvents", () => ({
  listeners: new Map<string, Set<CodexCatalogSubscription>>(),
  clients: new WeakMap<CodexAppServerClient, Promise<CodexCatalogClientBinding | undefined>>(),
}));

const CATALOG_NOTIFICATION_METHODS = new Set([
  "thread/started",
  "turn/started",
  "turn/completed",
  "thread/archived",
  "thread/deleted",
  "thread/unarchived",
  "thread/reverted",
  "thread/name/updated",
  "thread/status/changed",
  "thread/settings/updated",
]);

function notifyEphemeralThread(homeKey: string, rawId: string): void {
  const id = boundedCatalogString(rawId, MAX_SESSION_ID_LENGTH);
  if (!id) {
    return;
  }
  for (const listener of getCatalogEvents().listeners.get(homeKey) ?? []) {
    try {
      listener.onEphemeralThread?.(id);
    } catch (error) {
      embeddedAgentLog.warn("Codex catalog ephemeral observer failed", { error });
    }
  }
}

/** Uses prepared local identity or resolves it once during client/index startup. */
export async function codexCatalogResidentHomeKey(params: {
  startOptions: CodexAppServerStartOptions;
  agentDir?: string;
  sourceHomeId?: string;
  runtimeIdentity?: CodexAppServerRuntimeIdentity;
}): Promise<string> {
  if (inferCodexAppServerConnectionClass(params.startOptions) === "remote") {
    const fingerprint = buildCodexAppServerConnectionFingerprint(
      { start: params.startOptions, connectionClass: "remote" },
      params.agentDir,
    );
    return `remote:${createHash("sha256").update(fingerprint).digest("hex")}`;
  }
  if (params.sourceHomeId) {
    return params.sourceHomeId;
  }
  const home = path.resolve(
    params.runtimeIdentity?.codexHome ??
      resolveCodexAppServerLocalHomeDir(params.startOptions, params.agentDir),
  );
  return codexCatalogHomeIdFromCanonicalPath(await fs.realpath(home).catch(() => home));
}

export function subscribeCodexCatalogEvents(
  homeKey: string,
  listener: CodexCatalogEventListener,
  callbacks: CodexCatalogLifecycleCallbacks = {},
): () => void {
  const { listeners } = getCatalogEvents();
  let homeListeners = listeners.get(homeKey);
  if (!homeListeners) {
    homeListeners = new Set();
    listeners.set(homeKey, homeListeners);
  }
  const subscription = { notify: listener, ...callbacks };
  homeListeners.add(subscription);
  return () => {
    homeListeners.delete(subscription);
    if (homeListeners.size === 0 && listeners.get(homeKey) === homeListeners) {
      listeners.delete(homeKey);
    }
  };
}

/** Observes physical clients without extending their lease or native thread lifetime. */
export function observeCodexCatalogClient(
  client: CodexAppServerClient,
  params: { startOptions: CodexAppServerStartOptions; agentDir?: string },
): Promise<void> {
  const state = getCatalogEvents();
  const existing = state.clients.get(client);
  if (existing) {
    return existing.then(() => undefined);
  }
  const observing = (async () => {
    const homeKey = await codexCatalogResidentHomeKey({
      ...params,
      runtimeIdentity: client.getRuntimeIdentity(),
    });
    if (client.getCloseError()) {
      return undefined;
    }
    const source = codexCatalogSourceForClient(client);
    // Retain only the home key, never the client or its lease, in the source callback.
    observeCodexCatalogEphemeralThreads(source, notifyEphemeralThread.bind(undefined, homeKey));
    const notifyLifecycle = (callback: "onRemoteReady" | "onClose") => {
      for (const listener of state.listeners.get(homeKey) ?? []) {
        try {
          listener[callback]?.(source);
        } catch (error) {
          // Catalog observers must not replace physical startup or close outcomes.
          embeddedAgentLog.warn("Codex catalog lifecycle observer failed", { callback, error });
        }
      }
    };
    const readThread = async (threadId: string) =>
      (
        await client.request(
          "thread/read",
          { threadId, includeTurns: false },
          { timeoutMs: 60_000, catalogPreview: true },
        )
      ).thread;
    const stopNotifications = client.addNotificationHandler((event) => {
      if (!CATALOG_NOTIFICATION_METHODS.has(event.method)) {
        return;
      }
      for (const listener of state.listeners.get(homeKey) ?? []) {
        listener.notify(event, readThread, source);
      }
    });
    const stopClose = client.addCloseHandler(() => {
      stopNotifications();
      stopClose();
      notifyLifecycle("onClose");
    });
    if (inferCodexAppServerConnectionClass(params.startOptions) === "remote") {
      notifyLifecycle("onRemoteReady");
    }
    return { homeKey, source };
  })();
  state.clients.set(client, observing);
  return observing.then(() => undefined);
}

/** Acknowledged resume settings may differ from the response thread's persisted metadata. */
export function publishCodexCatalogResume(
  client: CodexAppServerClient,
  response: CodexCatalogResumeMetadata,
  sanitize: typeof sanitizeTerminalText,
): Promise<void> {
  try {
    return publishPreparedResume(client, {
      thread: projectCodexCatalogNativeThread(response.thread, sanitize),
      cwd: boundedCatalogString(response.cwd, MAX_CWD_LENGTH),
      modelProvider: boundedCatalogString(response.modelProvider, 500, "truncate"),
    });
  } catch (error) {
    embeddedAgentLog.warn("Codex catalog resume publication failed", { error });
    return Promise.resolve();
  }
}

async function publishPreparedResume(
  client: CodexAppServerClient,
  response: CodexCatalogResumeMetadata,
): Promise<void> {
  try {
    const state = getCatalogEvents();
    const binding = await state.clients.get(client);
    if (!binding || binding.source.closed) {
      return;
    }
    await Promise.all(
      Array.from(state.listeners.get(binding.homeKey) ?? [], async (listener) => {
        try {
          await listener.onResume?.(response, binding.source);
        } catch (error) {
          embeddedAgentLog.warn("Codex catalog resume observer failed", { error });
        }
      }),
    );
  } catch (error) {
    // Catalog publication never changes the outcome of a successful native resume.
    embeddedAgentLog.warn("Codex catalog resume publication failed", { error });
  }
}

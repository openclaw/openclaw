import type { AssistantMessage, Model } from "openclaw/plugin-sdk/llm";
import { vi } from "vitest";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
} from "./agent-session-loop-correctness.test-support.js";
import { createResourceLoader } from "./agent-session-loop-resource-loader.test-support.js";
import { createEventBus } from "./event-bus.js";
import { loadExtensionFromFactory } from "./extensions/loader.js";
import type { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

export function sessionTarget(
  storePath: string,
  sessionId: string,
  sessionKey = `agent:main:${sessionId}`,
) {
  return { agentId: "main", sessionId, sessionKey, storePath };
}

export async function extensionFixture(
  cwd: string,
  factory: Parameters<typeof loadExtensionFromFactory>[0],
  providedResourceLoader?: Awaited<ReturnType<typeof createResourceLoader>>,
) {
  const resourceLoader =
    providedResourceLoader ?? (await createResourceLoader(undefined, { cwd, agentDir: cwd }));
  const eventBus = createEventBus();
  const extensions = resourceLoader.getExtensions();
  extensions.extensions.push(
    await loadExtensionFromFactory(factory, cwd, eventBus, extensions.runtime),
  );
  return { resourceLoader, eventBus };
}

export function compactionSettings(
  compaction: {
    enabled?: boolean;
    reserveTokens?: number;
    keepRecentTokens?: number;
  } = {},
) {
  return SettingsManager.inMemory({
    compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 1, ...compaction },
    retry: { enabled: false },
  });
}

export function textStream(
  model: Model,
  text: string,
  stopReason: AssistantMessage["stopReason"] = "stop",
  tokens = 1,
) {
  return createAssistantResultStream(createAssistant(model, text, stopReason, tokens));
}

export async function safeguardFixture(
  model: Model,
  sessionManager: SessionManager,
  provider?: string,
  before?: Parameters<typeof loadExtensionFromFactory>[0],
) {
  const { setCompactionSafeguardRuntime } =
    await import("../agent-hooks/compaction-safeguard-runtime.js");
  const { default: safeguard } = await import("../agent-hooks/compaction-safeguard.js");
  setCompactionSafeguardRuntime(sessionManager, {
    model,
    ...(provider ? { provider } : {}),
    recentTurnsPreserve: 0,
    qualityGuardEnabled: true,
    qualityGuardMaxRetries: 0,
  });
  const network = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new Error("Unexpected network request in compaction test"));
  // `before` registers ahead of the safeguard, so it can decline before the safeguard runs.
  const first = before ? await extensionFixture(sessionManager.getCwd(), before) : undefined;
  const { resourceLoader, eventBus } = await extensionFixture(
    sessionManager.getCwd(),
    safeguard,
    first?.resourceLoader,
  );
  const settingsManager = compactionSettings({ reserveTokens: 64 });
  const { session } = await createTestSession({
    model,
    sessionManager,
    resourceLoader,
    settingsManager,
  });
  return {
    session,
    settingsManager,
    network,
    dispose() {
      setCompactionSafeguardRuntime(sessionManager, null);
      eventBus.clear();
      first?.eventBus.clear();
      network.mockRestore();
    },
  };
}

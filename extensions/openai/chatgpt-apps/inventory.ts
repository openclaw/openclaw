import type {
  ChatgptAppsInventorySnapshot,
  ChatgptAppsSidecarSession,
} from "./app-server-supervisor.js";
import type { AppInfo } from "./codex-sdk/generated/protocol/v2/AppInfo.js";

export const CHATGPT_APP_LINK_STATES = [
  "accessible",
  "linkable",
  "linked_but_locally_disabled",
  "unavailable",
] as const;

export const CHATGPT_APP_LINK_REASONS = [
  "already_accessible",
  "missing_install_url",
  "not_visible_when_unlinked",
  "app_not_found",
] as const;

export type ChatgptAppLinkState = (typeof CHATGPT_APP_LINK_STATES)[number];
export type ChatgptAppLinkReason = (typeof CHATGPT_APP_LINK_REASONS)[number];

export type ChatgptAppInventoryEntry = {
  id: string;
  name: string;
  installUrl: string | null;
  isAccessible: boolean;
  isEnabled: boolean;
  showInComposerWhenUnlinked: boolean | null;
  pluginDisplayNames: string[];
  linkState: ChatgptAppLinkState;
  linkReason: Exclude<ChatgptAppLinkReason, "app_not_found"> | null;
};

export type ChatgptAppInventoryGroups = {
  accessible: ChatgptAppInventoryEntry[];
  linkable: ChatgptAppInventoryEntry[];
  linkedButLocallyDisabled: ChatgptAppInventoryEntry[];
  unavailable: ChatgptAppInventoryEntry[];
};

export type ChatgptAppLinkCandidate =
  | {
      status: "ready";
      app: AppInfo;
      entry: ChatgptAppInventoryEntry;
    }
  | {
      status: "already_accessible";
      app: AppInfo;
      entry: ChatgptAppInventoryEntry;
      reason: "already_accessible";
    }
  | {
      status: "blocked";
      app: AppInfo | null;
      entry: ChatgptAppInventoryEntry | null;
      reason: Extract<
        ChatgptAppLinkReason,
        "missing_install_url" | "not_visible_when_unlinked" | "app_not_found"
      >;
    };

type InventoryWaitSession = Pick<
  ChatgptAppsSidecarSession,
  "onInventoryUpdate" | "refreshInventory" | "snapshot"
>;

type InventoryUpdateEvent =
  | {
      kind: "update";
      snapshot: ChatgptAppsInventorySnapshot;
    }
  | {
      kind: "poll";
    };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function summarizeChatgptApp(app: AppInfo): ChatgptAppInventoryEntry {
  const showInComposerWhenUnlinked = app.appMetadata?.showInComposerWhenUnlinked ?? null;
  const installUrl =
    typeof app.installUrl === "string" && app.installUrl.trim() ? app.installUrl : null;

  if (app.isAccessible && app.isEnabled) {
    return {
      id: app.id,
      name: app.name,
      installUrl,
      isAccessible: true,
      isEnabled: true,
      showInComposerWhenUnlinked,
      pluginDisplayNames: [...app.pluginDisplayNames],
      linkState: "accessible",
      linkReason: null,
    };
  }

  if (app.isAccessible && !app.isEnabled) {
    return {
      id: app.id,
      name: app.name,
      installUrl,
      isAccessible: true,
      isEnabled: false,
      showInComposerWhenUnlinked,
      pluginDisplayNames: [...app.pluginDisplayNames],
      linkState: "linked_but_locally_disabled",
      linkReason: "already_accessible",
    };
  }

  if (!installUrl) {
    return {
      id: app.id,
      name: app.name,
      installUrl: null,
      isAccessible: false,
      isEnabled: app.isEnabled,
      showInComposerWhenUnlinked,
      pluginDisplayNames: [...app.pluginDisplayNames],
      linkState: "unavailable",
      linkReason: "missing_install_url",
    };
  }

  if (showInComposerWhenUnlinked === false) {
    return {
      id: app.id,
      name: app.name,
      installUrl,
      isAccessible: false,
      isEnabled: app.isEnabled,
      showInComposerWhenUnlinked,
      pluginDisplayNames: [...app.pluginDisplayNames],
      linkState: "unavailable",
      linkReason: "not_visible_when_unlinked",
    };
  }

  return {
    id: app.id,
    name: app.name,
    installUrl,
    isAccessible: false,
    isEnabled: app.isEnabled,
    showInComposerWhenUnlinked,
    pluginDisplayNames: [...app.pluginDisplayNames],
    linkState: "linkable",
    linkReason: null,
  };
}

export function groupChatgptAppsInventory(apps: AppInfo[]): ChatgptAppInventoryGroups {
  const grouped: ChatgptAppInventoryGroups = {
    accessible: [],
    linkable: [],
    linkedButLocallyDisabled: [],
    unavailable: [],
  };

  for (const app of apps) {
    const entry = summarizeChatgptApp(app);
    if (entry.linkState === "accessible") {
      grouped.accessible.push(entry);
      continue;
    }
    if (entry.linkState === "linkable") {
      grouped.linkable.push(entry);
      continue;
    }
    if (entry.linkState === "linked_but_locally_disabled") {
      grouped.linkedButLocallyDisabled.push(entry);
      continue;
    }
    grouped.unavailable.push(entry);
  }

  return grouped;
}

function findAppById(apps: AppInfo[], appId: string): AppInfo | null {
  const normalizedId = appId.trim();
  return apps.find((app) => app.id === normalizedId) ?? null;
}

export function resolveChatgptAppLinkCandidate(
  apps: AppInfo[],
  appId: string,
): ChatgptAppLinkCandidate {
  const app = findAppById(apps, appId);
  if (!app) {
    return {
      status: "blocked",
      app: null,
      entry: null,
      reason: "app_not_found",
    };
  }

  const entry = summarizeChatgptApp(app);
  if (entry.linkState === "accessible" || entry.linkState === "linked_but_locally_disabled") {
    return {
      status: "already_accessible",
      app,
      entry,
      reason: "already_accessible",
    };
  }

  if (entry.linkState === "unavailable") {
    return {
      status: "blocked",
      app,
      entry,
      reason:
        entry.linkReason === "not_visible_when_unlinked"
          ? "not_visible_when_unlinked"
          : "missing_install_url",
    };
  }

  return {
    status: "ready",
    app,
    entry,
  };
}

function resolveAccessibleApp(apps: AppInfo[], appId: string): AppInfo | null {
  const app = findAppById(apps, appId);
  if (!app?.isAccessible) {
    return null;
  }
  return app;
}

export async function waitForChatgptAppAccessibility(params: {
  session: InventoryWaitSession;
  appId: string;
  timeoutMs: number;
  pollIntervalMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<AppInfo | null> {
  const now = params.now ?? Date.now;
  const sleepImpl = params.sleep ?? sleep;
  const initialApps = params.session.snapshot().inventory?.apps ?? [];
  const initialMatch = resolveAccessibleApp(initialApps, params.appId);
  if (initialMatch) {
    return initialMatch;
  }
  if (params.timeoutMs <= 0) {
    return null;
  }

  const pendingSnapshots: ChatgptAppsInventorySnapshot[] = [];
  let resolveNextEvent: ((event: InventoryUpdateEvent) => void) | null = null;
  const unsubscribe = params.session.onInventoryUpdate((snapshot) => {
    if (resolveNextEvent) {
      const resolve = resolveNextEvent;
      resolveNextEvent = null;
      resolve({ kind: "update", snapshot });
      return;
    }
    pendingSnapshots.push(snapshot);
  });
  const deadline = now() + params.timeoutMs;

  try {
    while (now() < deadline) {
      const remainingMs = Math.max(0, deadline - now());
      const waitMs = Math.min(params.pollIntervalMs, remainingMs);
      const nextEvent =
        pendingSnapshots.length > 0
          ? Promise.resolve<InventoryUpdateEvent>({
              kind: "update",
              snapshot: pendingSnapshots.shift()!,
            })
          : new Promise<InventoryUpdateEvent>((resolve) => {
              resolveNextEvent = resolve;
            });

      const event = await Promise.race([
        nextEvent,
        sleepImpl(waitMs).then(
          () =>
            ({
              kind: "poll",
            }) satisfies InventoryUpdateEvent,
        ),
      ]);

      if (event.kind === "update") {
        const accessible = resolveAccessibleApp(event.snapshot.apps, params.appId);
        if (accessible) {
          return accessible;
        }
        continue;
      }

      const refreshedApps = await params.session.refreshInventory({ forceRefetch: true });
      const accessible = resolveAccessibleApp(refreshedApps, params.appId);
      if (accessible) {
        return accessible;
      }
    }

    return null;
  } finally {
    resolveNextEvent = null;
    unsubscribe();
  }
}

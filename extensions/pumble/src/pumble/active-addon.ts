import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { Addon } from "pumble-sdk";

type ActiveAddon = {
  addon: Addon;
  workspaceId: string;
};

const ACTIVE_ADDONS_STATE_KEY = "__openclawPumbleActiveAddonsState";

function resolveActiveAddonsMap(): Map<string, ActiveAddon> {
  const g = globalThis as typeof globalThis & {
    [ACTIVE_ADDONS_STATE_KEY]?: Map<string, ActiveAddon>;
  };
  if (!g[ACTIVE_ADDONS_STATE_KEY]) {
    g[ACTIVE_ADDONS_STATE_KEY] = new Map<string, ActiveAddon>();
  }
  return g[ACTIVE_ADDONS_STATE_KEY];
}

const activeAddons = resolveActiveAddonsMap();

export function setActivePumbleAddon(
  addon: Addon | null,
  workspaceId: string,
  accountId?: string | null,
): void {
  const key = normalizeAccountId(accountId);
  if (addon) {
    activeAddons.set(key, { addon, workspaceId });
  } else {
    activeAddons.delete(key);
  }
}

export function getActivePumbleAddon(accountId?: string | null): ActiveAddon | null {
  const key = normalizeAccountId(accountId);
  return activeAddons.get(key) ?? null;
}

export function clearAllActivePumbleAddons(): void {
  activeAddons.clear();
}

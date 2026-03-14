import type { MattermostSlashCommandConfig } from "./slash-commands.js";

const DEFAULT_CALLBACK_PATH = "/api/channels/mattermost/command";

function normalizeCallbackPath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return DEFAULT_CALLBACK_PATH;
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function resolveSlashCommandConfig(
  raw?: Partial<MattermostSlashCommandConfig>,
): MattermostSlashCommandConfig {
  return {
    native: raw?.native ?? "auto",
    nativeSkills: raw?.nativeSkills ?? "auto",
    callbackPath: normalizeCallbackPath(raw?.callbackPath ?? DEFAULT_CALLBACK_PATH),
    callbackUrl: raw?.callbackUrl?.trim() || undefined,
  };
}

export function resolveSlashCallbackPaths(mmConfig: Record<string, unknown> | undefined): string[] {
  const callbackPaths = new Set<string>();

  const addCallbackPaths = (raw: Partial<MattermostSlashCommandConfig> | undefined) => {
    const resolved = resolveSlashCommandConfig(raw);
    callbackPaths.add(resolved.callbackPath);
    if (!resolved.callbackUrl) {
      return;
    }
    try {
      const urlPath = new URL(resolved.callbackUrl).pathname;
      if (urlPath && urlPath !== resolved.callbackPath) {
        callbackPaths.add(urlPath);
      }
    } catch {
      // Invalid URLs are validated later by the registration flow.
    }
  };

  addCallbackPaths(mmConfig?.commands as Partial<MattermostSlashCommandConfig> | undefined);

  const accountsRaw = (mmConfig?.accounts ?? {}) as Record<string, unknown>;
  for (const accountId of Object.keys(accountsRaw)) {
    const accountCfg = accountsRaw[accountId] as Record<string, unknown> | undefined;
    addCallbackPaths(accountCfg?.commands as Partial<MattermostSlashCommandConfig> | undefined);
  }

  return [...callbackPaths];
}

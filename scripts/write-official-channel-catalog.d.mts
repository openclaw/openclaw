export const OFFICIAL_CHANNEL_CATALOG_RELATIVE_PATH: "dist/channel-catalog.json";

export function buildOfficialChannelCatalog(params?: { repoRoot?: string; cwd?: string }): {
  entries: Array<{
    name: string;
    version?: string;
    description?: string;
    openclaw: {
      channel: Record<string, unknown>;
      install: {
        npmSpec: string;
        localPath?: string;
        defaultChoice?: "npm" | "local";
      };
    };
  }>;
};

export function writeOfficialChannelCatalog(params?: { repoRoot?: string; cwd?: string }): void;

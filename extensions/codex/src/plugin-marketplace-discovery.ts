/** Read-only discovery of Codex-owned local, curated, and remote plugin marketplaces. */
import { asOptionalRecord as readRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CODEX_PLUGIN_MARKETPLACE_NAME_PATTERN } from "./app-server/config-contracts.shared.js";
import type { v2 } from "./app-server/protocol.js";

// Codex permits dots between plugin-name segments, but not in marketplace names.
const PLUGIN_NAME_PATTERN = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const MAX_PLUGIN_METADATA_LENGTH = 160;
const SUPPLEMENTAL_MARKETPLACE_KINDS = [
  "workspace-directory",
  "shared-with-me",
  "created-by-me-remote",
  "vertical",
] as const;

/** Safe, bounded marketplace record returned to operator and model discovery surfaces. */
export type CodexAvailablePlugin = {
  id: string;
  pluginName: string;
  marketplaceName: string;
  displayName?: string;
  developerName?: string;
  description?: string;
  installed: boolean;
  enabled: boolean;
  available: boolean;
  installPolicy?: string;
  authPolicy?: string;
  marketplacePath?: string;
  remotePluginId?: string;
  mustShowInstallationInterstitial?: boolean | null;
  summaryId: string;
};

type CodexPluginDiscoveryResult = {
  plugins: CodexAvailablePlugin[];
  warnings: string[];
};

export type CodexPluginMarketplaceListRequest = (
  params: v2.PluginListParams,
) => Promise<v2.PluginListResponse>;

export function filterCodexMarketplacePlugins(
  plugins: CodexAvailablePlugin[],
  query: string,
  marketplace?: string,
): CodexAvailablePlugin[] {
  const normalizedQuery = query.trim().toLowerCase();
  return plugins.filter(
    (plugin) =>
      (!marketplace || plugin.marketplaceName === marketplace) &&
      (!normalizedQuery ||
        `${plugin.id} ${plugin.displayName ?? ""} ${plugin.developerName ?? ""} ${plugin.description ?? ""}`
          .toLowerCase()
          .includes(normalizedQuery)),
  );
}

/** Validates the same identifier segments required by Codex's stable PluginId parser. */
export function parseCodexPluginMarketplaceId(
  value: string,
): { pluginName: string; marketplaceName: string } | undefined {
  const separator = value.lastIndexOf("@");
  if (separator <= 0 || separator === value.length - 1) {
    return undefined;
  }
  const pluginName = value.slice(0, separator);
  const marketplaceName = value.slice(separator + 1);
  return PLUGIN_NAME_PATTERN.test(pluginName) &&
    CODEX_PLUGIN_MARKETPLACE_NAME_PATTERN.test(marketplaceName)
    ? { pluginName, marketplaceName }
    : undefined;
}

/** Lists local/global first and separately requests workspace, shared, and personal catalogs. */
export async function discoverCodexMarketplacePlugins(params: {
  request: CodexPluginMarketplaceListRequest;
  workspaceDir: string;
}): Promise<CodexPluginDiscoveryResult> {
  const requestParams: v2.PluginListParams = { cwds: [params.workspaceDir] };
  const warnings: string[] = [];
  const marketplaces: v2.PluginMarketplaceEntry[] = [];
  const readMarketplaces = async (marketplaceKinds?: v2.PluginListParams["marketplaceKinds"]) => {
    const response = await params.request({
      ...requestParams,
      ...(marketplaceKinds ? { marketplaceKinds } : {}),
    });
    marketplaces.push(...response.marketplaces);
    warnings.push(
      ...(response.marketplaceLoadErrors ?? []).map((error) => boundedCatalogText(error.message)),
    );
    return response.marketplaces.length > 0;
  };
  await readMarketplaces();

  try {
    await readMarketplaces([...SUPPLEMENTAL_MARKETPLACE_KINDS]);
  } catch (error) {
    let recoveredSupplementalMarketplace = false;
    for (const kind of SUPPLEMENTAL_MARKETPLACE_KINDS) {
      try {
        const found = await readMarketplaces([kind]);
        recoveredSupplementalMarketplace ||= found;
      } catch (kindError) {
        warnings.push(
          boundedCatalogText(
            `${kind} marketplace unavailable: ${
              kindError instanceof Error ? kindError.message : String(kindError)
            }`,
          ),
        );
      }
    }
    if (!recoveredSupplementalMarketplace && warnings.length === 0) {
      warnings.push(
        boundedCatalogText(
          `Additional marketplaces could not be listed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    }
  }

  const discovered = new Map<string, CodexAvailablePlugin>();
  const ambiguous = new Set<string>();
  for (const marketplace of marketplaces) {
    if (!CODEX_PLUGIN_MARKETPLACE_NAME_PATTERN.test(marketplace.name)) {
      continue;
    }
    for (const summary of marketplace.plugins) {
      const pluginName = pluginSlug(summary, marketplace.name);
      if (!pluginName) {
        continue;
      }
      const id = `${pluginName}@${marketplace.name}`;
      if (ambiguous.has(id)) {
        continue;
      }
      const previous = discovered.get(id);
      const pluginInterface = readRecord(summary.interface);
      const next: CodexAvailablePlugin = {
        id,
        pluginName,
        marketplaceName: marketplace.name,
        displayName: boundedCatalogText(pluginInterface?.displayName) || undefined,
        developerName: boundedCatalogText(pluginInterface?.developerName) || undefined,
        description:
          boundedCatalogText(pluginInterface?.shortDescription) ||
          boundedCatalogText(pluginInterface?.longDescription) ||
          undefined,
        installed: summary.installed,
        enabled: summary.enabled,
        available:
          summary.availability !== "DISABLED_BY_ADMIN" && summary.installPolicy !== "NOT_AVAILABLE",
        ...(summary.installPolicy ? { installPolicy: summary.installPolicy } : {}),
        ...(summary.authPolicy ? { authPolicy: summary.authPolicy } : {}),
        ...(marketplace.path ? { marketplacePath: marketplace.path } : {}),
        ...(summary.remotePluginId?.trim()
          ? {
              remotePluginId: summary.remotePluginId.trim(),
              mustShowInstallationInterstitial: summary.mustShowInstallationInterstitial ?? null,
            }
          : {}),
        summaryId: summary.id,
      };
      if (
        previous &&
        (previous.marketplacePath !== next.marketplacePath ||
          previous.remotePluginId !== next.remotePluginId)
      ) {
        discovered.delete(id);
        ambiguous.add(id);
        warnings.push(
          `Multiple discovered plugins share ${id}; installation requires a unique identity.`,
        );
        continue;
      }
      const preferred =
        !previous ||
        (!previous.installed && next.installed) ||
        (!previous.enabled && next.installed && next.enabled)
          ? next
          : previous;
      if (previous) {
        preferred.available = previous.available && next.available;
        if (preferred.remotePluginId) {
          preferred.mustShowInstallationInterstitial =
            previous.mustShowInstallationInterstitial === true ||
            next.mustShowInstallationInterstitial === true
              ? true
              : previous.mustShowInstallationInterstitial === false &&
                  next.mustShowInstallationInterstitial === false
                ? false
                : null;
        }
        if (previous.installPolicy === "NOT_AVAILABLE" || next.installPolicy === "NOT_AVAILABLE") {
          preferred.installPolicy = "NOT_AVAILABLE";
        }
      }
      discovered.set(id, preferred);
    }
  }

  return {
    plugins: [...discovered.values()].toSorted((left, right) => left.id.localeCompare(right.id)),
    warnings,
  };
}

function pluginSlug(summary: v2.PluginSummary, marketplaceName: string): string | undefined {
  const qualified = parseCodexPluginMarketplaceId(summary.id);
  if (qualified?.marketplaceName === marketplaceName) {
    return qualified.pluginName;
  }
  const identitySegment = summary.id.split("/").at(-1);
  if (identitySegment && PLUGIN_NAME_PATTERN.test(identitySegment)) {
    return identitySegment;
  }
  return PLUGIN_NAME_PATTERN.test(summary.name) ? summary.name : undefined;
}

function boundedCatalogText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return value
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PLUGIN_METADATA_LENGTH);
}

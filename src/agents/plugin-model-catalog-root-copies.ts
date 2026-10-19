/**
 * Finds generated plugin catalog blocks that older writers copied into the author-owned root
 * models.json.
 *
 * Discovery copies a plugin's provider under its hook aliases (`claude-cli` received the
 * `anthropic` catalog). When the owner lookup failed, the writer sent that copy to the root file,
 * and the merge kept it forever. Its frozen prices, including zero placeholders for unpriced
 * models, then outranked the live catalog. Only exact copies of a generated block qualify;
 * anything a user could have edited stays.
 */
import { isDeepStrictEqual } from "node:util";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { isRecord } from "../utils.js";
import {
  isGeneratedPluginModelCatalog,
  resolvePluginModelCatalogOwnerPluginId,
  type PersistedPluginModelCatalog,
} from "./plugin-model-catalog.js";

/** Generated blocks carry exactly these keys; credentials or request overrides mean authorship. */
const GENERATED_PROVIDER_KEYS = ["api", "baseUrl", "models"];

type RootProviderCopy = Readonly<{
  providerId: string;
  /** Plugin whose generated catalog holds the identical block. */
  pluginId: string;
  /** Provider key of the identical block inside that catalog. */
  catalogProviderId: string;
}>;

export type RootProviderCopyReview = Readonly<{
  copies: RootProviderCopy[];
  /** Plugin-owned root ids left in place because they differ from every generated block. */
  keptPluginOwnedIds: string[];
}>;

type GeneratedBlock = Readonly<{ pluginId: string; providerId: string; block: unknown }>;

function readGeneratedBlocks(catalogs: readonly PersistedPluginModelCatalog[]): GeneratedBlock[] {
  return catalogs.flatMap(({ pluginId, contents }) => {
    const catalog = safeParseJsonRecord(contents);
    if (!isGeneratedPluginModelCatalog(catalog) || !isRecord(catalog.providers)) {
      return [];
    }
    return Object.entries(catalog.providers).map(([providerId, block]) => ({
      pluginId,
      providerId,
      block,
    }));
  });
}

function hasOnlyGeneratedProviderKeys(block: Record<string, unknown>): boolean {
  return (
    isDeepStrictEqual(Object.keys(block).toSorted(), GENERATED_PROVIDER_KEYS) &&
    Array.isArray(block.models)
  );
}

/**
 * Reviews root providers against generated catalogs. A root block is a copy only when config does
 * not declare its id, it carries nothing but generated keys, no other plugin owns the id, and it
 * deep-equals a block in that plugin's generated catalog.
 */
export function reviewRootProviderCopies(params: {
  rootProviders: Readonly<Record<string, unknown>>;
  explicitProviderIds: ReadonlySet<string>;
  catalogs: readonly PersistedPluginModelCatalog[];
  pluginMetadataSnapshot: Parameters<
    typeof resolvePluginModelCatalogOwnerPluginId
  >[0]["pluginMetadataSnapshot"];
}): RootProviderCopyReview {
  const generated = readGeneratedBlocks(params.catalogs);
  const copies: RootProviderCopy[] = [];
  const keptPluginOwnedIds: string[] = [];
  for (const [providerId, block] of Object.entries(params.rootProviders)) {
    if (params.explicitProviderIds.has(normalizeProviderId(providerId))) {
      continue;
    }
    const owner = resolvePluginModelCatalogOwnerPluginId({
      providerId,
      pluginMetadataSnapshot: params.pluginMetadataSnapshot,
    });
    const match =
      isRecord(block) && hasOnlyGeneratedProviderKeys(block)
        ? generated.find(
            (candidate) =>
              (owner === undefined || owner === candidate.pluginId) &&
              isDeepStrictEqual(candidate.block, block),
          )
        : undefined;
    if (match) {
      copies.push({ providerId, pluginId: match.pluginId, catalogProviderId: match.providerId });
    } else if (owner !== undefined) {
      keptPluginOwnedIds.push(providerId);
    }
  }
  return { copies, keptPluginOwnedIds };
}

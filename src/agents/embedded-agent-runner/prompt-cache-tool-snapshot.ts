import { sortPromptCacheToolsByName } from "@openclaw/ai/internal/shared";
import { stableStringify } from "@openclaw/normalization-core";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";

export type PromptCacheToolSnapshot = {
  name: string;
  descriptionDigest?: string;
  schemaDigest?: string;
};

type PromptCacheToolDescriptor = {
  readonly name?: string;
  readonly description?: string;
  readonly parameters?: object;
};

// Provider-owned schemas are immutable declarations, unlike transcript blocks.
const toolSchemaFingerprints = new WeakMap<object, string>();

export function collectPromptCacheTools(
  tools: readonly PromptCacheToolDescriptor[],
): PromptCacheToolSnapshot[] {
  const snapshots: PromptCacheToolSnapshot[] = [];
  for (const tool of tools) {
    try {
      const name = tool.name?.trim();
      if (!name) {
        continue;
      }
      const { description, parameters } = tool;
      let schemaDigest: string | undefined;
      if (parameters) {
        schemaDigest = toolSchemaFingerprints.get(parameters);
        if (!schemaDigest) {
          schemaDigest = sha256Hex(stableStringify(parameters));
          toolSchemaFingerprints.set(parameters, schemaDigest);
        }
      }
      snapshots.push({
        name,
        descriptionDigest: description === undefined ? undefined : sha256Hex(description),
        schemaDigest,
      });
    } catch {
      continue;
    }
  }
  return sortPromptCacheToolsByName(snapshots);
}

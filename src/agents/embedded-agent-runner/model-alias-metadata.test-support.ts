import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";

export function createModelAliasMetadata(provider: string, aliases: Record<string, string>) {
  return createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: provider,
        providers: [provider],
        modelIdNormalization: { providers: { [provider]: { aliases } } },
      },
    ],
  });
}

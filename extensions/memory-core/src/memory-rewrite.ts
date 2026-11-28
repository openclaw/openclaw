import { recordCuratedMemoryArtifactRewrite } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import {
  commitMemoryContent,
  MemoryAtomicPublicationError,
} from "./short-term-promotion-memory-write.js";

/**
 * Rewrites a memory file for an automatic writer. For curated MEMORY.md/USER.md the
 * host moves the provenance record to the published bytes, so an untrusted file stays
 * untrusted. Record on the Gateway: remote maintenance workers only publish bytes.
 */
export async function commitMemoryRewrite(
  params: Parameters<typeof commitMemoryContent>[0] & {
    workspaceDir: string;
    relativePath: string;
  },
): Promise<void> {
  const { relativePath, ...commit } = params;
  const rollback =
    params.content === null
      ? undefined
      : await recordCuratedMemoryArtifactRewrite({
          workspaceDir: params.workspaceDir,
          relativePath,
          contentAfter: params.content,
          observedAt: Date.now(),
        });
  try {
    await commitMemoryContent(commit);
  } catch (error) {
    // A publication that may have committed keeps the record for its bytes.
    if (!(error instanceof MemoryAtomicPublicationError)) {
      await rollback?.();
    }
    throw error;
  }
}

import type { MemoryProviderStatus } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export function captureMemoryRebuildNotice(status: MemoryProviderStatus): () => string | undefined {
  const notice = asNullableRecord(status.custom?.automaticRebuildNotice);
  const sequence = notice?.sequence;
  // Hold the owner's live notice through deadlines and manager retirement.
  return () =>
    notice?.sequence !== sequence && typeof notice?.warning === "string"
      ? notice.warning
      : undefined;
}

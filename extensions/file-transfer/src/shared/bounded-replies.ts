import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export const BOUNDED_UNARY_FILE_BYTES = 2 * 1024 * 1024;
export const BOUNDED_LINUX_PATH_BYTES = 4095;

// Linux allows a 4,095-byte path and a 255-byte name. Each entry repeats the
// name and absolute path. Reserve seven encoded bytes per path byte, 512 bytes
// per entry for metadata, and 64 KiB for the envelope (3,996,016 bytes total).
export const BOUNDED_DIRECTORY_PAGE_SIZE = 120;

export function usesBoundedReplies(config: unknown, nodeId: string): boolean {
  const nodes = asOptionalRecord(asOptionalRecord(config)?.nodes);
  return (
    nodes !== undefined &&
    Object.hasOwn(nodes, nodeId) &&
    asOptionalRecord(nodes[nodeId])?.boundedReplies === true
  );
}

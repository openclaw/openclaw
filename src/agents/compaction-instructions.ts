import type { OpenClawConfig } from "../config/config.js";

export const DEFAULT_COMPACTION_INSTRUCTIONS = `Preserve ALL exact identifiers verbatim, including:
- UUIDs and GUIDs
- IP addresses, hostnames, and ports
- Git commit SHAs and branch names
- Docker container IDs and image hashes
- API endpoint paths and URL-embedded IDs
- Database row IDs and table names
- Session tokens and auth headers
- Kubernetes pod/service/namespace names
- Version numbers and build IDs
- Serial numbers and MAC addresses
- Connection strings and DSNs
- File paths and function names
- Error messages and stack traces
Never truncate, abbreviate, or omit these values.`;

export function resolveCompactionInstructions(config: OpenClawConfig | undefined): string {
  const custom = config?.agents?.defaults?.compaction?.customInstructions;
  if (typeof custom === "string" && custom.trim().length > 0) {
    return custom;
  }
  return DEFAULT_COMPACTION_INSTRUCTIONS;
}

/**
 * Shared contract for the persistent Claude stdio runtime.
 */
import type { CliBackendConfig } from "../../config/types.js";

/** Returns whether a Claude backend can route every tool permission through the live callback. */
export function isClaudeLiveSessionTransport(backend: CliBackendConfig): boolean {
  return (
    backend.liveSession === "claude-stdio" &&
    backend.output === "jsonl" &&
    (backend.resumeOutput === undefined || backend.resumeOutput === "jsonl") &&
    backend.input === "stdin"
  );
}

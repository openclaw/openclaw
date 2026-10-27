import { sha256Hex } from "../../infra/crypto-digest.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

export const cliBackendLog = createSubsystemLogger("agent/cli-backend");
export const CLI_BACKEND_LOG_OUTPUT_ENV = "OPENCLAW_CLI_BACKEND_LOG_OUTPUT";

export function formatCliBackendOutputDigest(text: string): string {
  const outBytes = Buffer.byteLength(text, "utf8");
  const outHash = sha256Hex(text).slice(0, 12);
  return `outBytes=${outBytes} outHash=${outHash}`;
}

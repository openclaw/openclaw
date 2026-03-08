import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AcpxCodexBootstrapState } from "./shared.js";

const CODEX_BOOTSTRAP_WRAPPER_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "codex-bootstrap-wrapper.mjs",
);

function quoteCommandPart(value: string): string {
  if (value === "") {
    return '""';
  }
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) {
    return value;
  }
  return `"${value.replace(/["\\]/g, "\\$&")}"`;
}

function toCommandLine(parts: string[]): string {
  return parts.map(quoteCommandPart).join(" ");
}

export function buildCodexBootstrapAgentCommand(params: {
  targetCommand: string;
  bootstrap: AcpxCodexBootstrapState;
}): string {
  const payload = Buffer.from(
    JSON.stringify({
      targetCommand: params.targetCommand,
      bootstrap: params.bootstrap,
    }),
    "utf8",
  ).toString("base64url");
  return toCommandLine([process.execPath, CODEX_BOOTSTRAP_WRAPPER_PATH, "--payload", payload]);
}

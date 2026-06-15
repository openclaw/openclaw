// @openclaw/agent-sdk — SHA-256 content hashing for integrity manifest.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function hashFile(filePath: string): string {
  const content = readFileSync(filePath);
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

export function hashString(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

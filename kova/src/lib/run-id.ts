import { randomBytes } from "node:crypto";

export function createKovaRunId(now = new Date()) {
  const stamp = now
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replaceAll(".", "")
    .replace("T", "_")
    .replace("Z", "");
  const entropy = randomBytes(3).toString("hex");
  return `kova_${stamp}_${entropy}`;
}

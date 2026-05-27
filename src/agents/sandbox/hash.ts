import crypto from "node:crypto";

export function hashTextSha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

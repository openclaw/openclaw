import { createHmac, timingSafeEqual } from "node:crypto";

export function buildDailyflowsSignature(secret: string, timestamp: string, body: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(`${timestamp}.${body}`);
  return `v1=${hmac.digest("hex")}`;
}

export function isDailyflowsSignatureValid(params: {
  secret: string;
  timestamp: string;
  signature: string;
  body: string;
}): boolean {
  const hmac = createHmac("sha256", params.secret);
  hmac.update(`${params.timestamp}.${params.body}`);
  const expected = hmac.digest();

  const prefix = "v1=";
  if (!params.signature.startsWith(prefix)) {
    return false;
  }
  const provided = Buffer.from(params.signature.slice(prefix.length), "hex");

  if (provided.length !== expected.length) {
    timingSafeEqual(expected, expected);
    return false;
  }
  return timingSafeEqual(expected, provided);
}

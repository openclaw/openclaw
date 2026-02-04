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
  const expected = buildDailyflowsSignature(params.secret, params.timestamp, params.body);
  const expectedBuf = Buffer.from(expected);
  const signatureBuf = Buffer.from(params.signature);
  if (expectedBuf.length !== signatureBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, signatureBuf);
}

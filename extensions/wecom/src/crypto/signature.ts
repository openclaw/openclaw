/**
 * WeCom 签名计算与验证
 */

import crypto from "node:crypto";

function sha1Hex(input: string): string {
  return crypto.createHash("sha1").update(input).digest("hex");
}

/**
 * 计算 WeCom 消息签名
 */
export function computeWecomMsgSignature(params: {
  token: string;
  timestamp: string;
  nonce: string;
  encrypt: string;
}): string {
  const parts = [params.token, params.timestamp, params.nonce, params.encrypt]
    .map((v) => String(v ?? ""))
    .sort();
  return sha1Hex(parts.join(""));
}

/**
 * 验证 WeCom 消息签名
 */
export function verifyWecomSignature(params: {
  token: string;
  timestamp: string;
  nonce: string;
  encrypt: string;
  signature: string;
}): boolean {
  const expected = computeWecomMsgSignature({
    token: params.token,
    timestamp: params.timestamp,
    nonce: params.nonce,
    encrypt: params.encrypt,
  });
  return expected === params.signature;
}

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

function sha1Hex(parts: string[]): string {
  return createHash("sha1").update(parts.sort().join("")).digest("hex");
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    const dummy = Buffer.from(a);
    timingSafeEqual(dummy, dummy);
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function verifySignature(
  signature: string,
  timestamp: string,
  nonce: string,
  token: string,
): boolean {
  return safeEqual(sha1Hex([token, timestamp, nonce]), signature);
}

export function verifyMessageSignature(
  signature: string,
  timestamp: string,
  nonce: string,
  encrypted: string,
  token: string,
): boolean {
  return safeEqual(sha1Hex([token, timestamp, nonce, encrypted]), signature);
}

function decodeAesKey(encodingAESKey: string): Buffer {
  return Buffer.from(`${encodingAESKey}=`, "base64");
}

function pkcs7Unpad(buf: Buffer): Buffer {
  if (buf.length === 0) return buf;
  const pad = buf[buf.length - 1] || 0;
  if (pad <= 0 || pad > 32) return buf;
  for (let i = buf.length - pad; i < buf.length; i++) {
    if (buf[i] !== pad) return buf;
  }
  return buf.subarray(0, buf.length - pad);
}

function pkcs7Pad(buf: Buffer, blockSize = 32): Buffer {
  const amount = blockSize - (buf.length % blockSize);
  return Buffer.concat([buf, Buffer.alloc(amount, amount)]);
}

export function decryptWechatMessage(
  encrypted: string,
  encodingAESKey: string,
  appId?: string,
): string {
  const key = decodeAesKey(encodingAESKey);
  const iv = key.subarray(0, 16);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64")),
    decipher.final(),
  ]);
  const plain = pkcs7Unpad(decrypted);
  const msgLength = plain.readUInt32BE(16);
  const xmlStart = 20;
  const xmlEnd = xmlStart + msgLength;
  const xml = plain.subarray(xmlStart, xmlEnd).toString("utf8");
  const fromAppId = plain.subarray(xmlEnd).toString("utf8");
  if (appId && fromAppId && fromAppId !== appId) throw new Error("appId mismatch");
  return xml;
}

export function encryptWechatMessage(xml: string, encodingAESKey: string, appId: string): string {
  const key = decodeAesKey(encodingAESKey);
  const iv = key.subarray(0, 16);
  const random16 = randomBytes(16);
  const xmlBuf = Buffer.from(xml, "utf8");
  const msgLen = Buffer.alloc(4);
  msgLen.writeUInt32BE(xmlBuf.length, 0);
  const payload = pkcs7Pad(Buffer.concat([random16, msgLen, xmlBuf, Buffer.from(appId, "utf8")]));
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(payload), cipher.final()]).toString("base64");
}

export function buildEncryptedReply(params: {
  xml: string;
  token: string;
  encodingAESKey: string;
  appId: string;
  timestamp: string;
  nonce: string;
}): string {
  const encrypt = encryptWechatMessage(params.xml, params.encodingAESKey, params.appId);
  const signature = sha1Hex([params.token, params.timestamp, params.nonce, encrypt]);
  return `<xml>\n<Encrypt><![CDATA[${encrypt}]]></Encrypt>\n<MsgSignature><![CDATA[${signature}]]></MsgSignature>\n<TimeStamp>${params.timestamp}</TimeStamp>\n<Nonce><![CDATA[${params.nonce}]]></Nonce>\n</xml>`;
}

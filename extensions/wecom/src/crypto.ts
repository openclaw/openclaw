import crypto from "node:crypto";

/**
 * **decodeEncodingAESKey (解码 AES Key)**
 * 
 * 将企业微信配置的 Base64 编码的 AES Key 解码为 Buffer。
 * 包含补全 Padding 和长度校验 (必须32字节)。
 */
export function decodeEncodingAESKey(encodingAESKey: string): Buffer {
  const trimmed = encodingAESKey.trim();
  if (!trimmed) throw new Error("encodingAESKey missing");
  const withPadding = trimmed.endsWith("=") ? trimmed : `${trimmed}=`;
  const key = Buffer.from(withPadding, "base64");
  if (key.length !== 32) {
    throw new Error(`invalid encodingAESKey (expected 32 bytes after base64 decode, got ${key.length})`);
  }
  return key;
}

// WeCom uses PKCS#7 padding with a block size of 32 bytes (not AES's 16-byte block).
// This is compatible with AES-CBC as 32 is a multiple of 16, but it requires manual padding/unpadding.
export const WECOM_PKCS7_BLOCK_SIZE = 32;

function pkcs7Pad(buf: Buffer, blockSize: number): Buffer {
  const mod = buf.length % blockSize;
  const pad = mod === 0 ? blockSize : blockSize - mod;
  const padByte = Buffer.from([pad]);
  return Buffer.concat([buf, Buffer.alloc(pad, padByte[0]!)]);
}

/**
 * **pkcs7Unpad (去除 PKCS#7 填充)**
 * 
 * 移除 AES 解密后的 PKCS#7 填充字节。
 * 包含填充合法性校验。
 */
export function pkcs7Unpad(buf: Buffer, blockSize: number): Buffer {
  if (buf.length === 0) throw new Error("invalid pkcs7 payload");
  const pad = buf[buf.length - 1]!;
  if (pad < 1 || pad > blockSize) {
    throw new Error("invalid pkcs7 padding");
  }
  if (pad > buf.length) {
    throw new Error("invalid pkcs7 payload");
  }
  // Best-effort validation (all padding bytes equal).
  for (let i = 0; i < pad; i += 1) {
    if (buf[buf.length - 1 - i] !== pad) {
      throw new Error("invalid pkcs7 padding");
    }
  }
  return buf.subarray(0, buf.length - pad);
}

function sha1Hex(input: string): string {
  return crypto.createHash("sha1").update(input).digest("hex");
}

/**
 * **computeWecomMsgSignature (计算消息签名)**
 * 
 * 算法：sha1(sort(token, timestamp, nonce, encrypt_msg))
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
 * **verifyWecomSignature (验证消息签名)**
 * 
 * 比较计算出的签名与企业微信传入的签名是否一致。
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

/**
 * **decryptWecomEncrypted (解密企业微信消息)**
 * 
 * 将企业微信的 AES 加密包解密为明文。
 * 流程：
 * 1. Base64 解码 AESKey 并获取 IV (前16字节)。
 * 2. AES-CBC 解密。
 * 3. 去除 PKCS#7 填充。
 * 4. 拆解协议包结构: [16字节随机串][4字节长度][消息体][接收者ID]。
 * 5. 校验接收者ID (ReceiveId)。
 */
export function decryptWecomEncrypted(params: {
  encodingAESKey: string;
  receiveId?: string;
  encrypt: string;
}): string {
  const aesKey = decodeEncodingAESKey(params.encodingAESKey);
  const iv = aesKey.subarray(0, 16);
  const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, iv);
  decipher.setAutoPadding(false);
  const decryptedPadded = Buffer.concat([
    decipher.update(Buffer.from(params.encrypt, "base64")),
    decipher.final(),
  ]);
  const decrypted = pkcs7Unpad(decryptedPadded, WECOM_PKCS7_BLOCK_SIZE);

  if (decrypted.length < 20) {
    throw new Error(`invalid decrypted payload (expected at least 20 bytes, got ${decrypted.length})`);
  }

  // 16 bytes random + 4 bytes network-order length + msg + receiveId (optional)
  const msgLen = decrypted.readUInt32BE(16);
  const msgStart = 20;
  const msgEnd = msgStart + msgLen;
  if (msgEnd > decrypted.length) {
    throw new Error(`invalid decrypted msg length (msgEnd=${msgEnd}, payloadLength=${decrypted.length})`);
  }
  const msg = decrypted.subarray(msgStart, msgEnd).toString("utf8");

  const receiveId = params.receiveId ?? "";
  if (receiveId) {
    const trailing = decrypted.subarray(msgEnd).toString("utf8");
    if (trailing !== receiveId) {
      throw new Error(`receiveId mismatch (expected "${receiveId}", got "${trailing}")`);
    }
  }

  return msg;
}

/**
 * **encryptWecomPlaintext (加密回复消息)**
 * 
 * 将明文消息打包为企业微信的加密格式。
 * 流程：
 * 1. 构造协议包: [16字节随机串][4字节长度][消息体][接收者ID]。
 * 2. PKCS#7 填充。
 * 3. AES-CBC 加密。
 * 4. 转 Base64。
 */
export function encryptWecomPlaintext(params: {
  encodingAESKey: string;
  receiveId?: string;
  plaintext: string;
}): string {
  const aesKey = decodeEncodingAESKey(params.encodingAESKey);
  const iv = aesKey.subarray(0, 16);
  const random16 = crypto.randomBytes(16);
  const msg = Buffer.from(params.plaintext ?? "", "utf8");
  const msgLen = Buffer.alloc(4);
  msgLen.writeUInt32BE(msg.length, 0);
  const receiveId = Buffer.from(params.receiveId ?? "", "utf8");

  const raw = Buffer.concat([random16, msgLen, msg, receiveId]);
  const padded = pkcs7Pad(raw, WECOM_PKCS7_BLOCK_SIZE);
  const cipher = crypto.createCipheriv("aes-256-cbc", aesKey, iv);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
  return encrypted.toString("base64");
}

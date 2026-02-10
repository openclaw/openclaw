/**
 * WeCom AES-256-CBC 加解密核心
 * Bot 和 Agent 模式共用
 */

import crypto from "node:crypto";
import { CRYPTO } from "../types/constants.js";

export function decodeEncodingAESKey(encodingAESKey: string): Buffer {
    const trimmed = encodingAESKey.trim();
    if (!trimmed) throw new Error("encodingAESKey missing");
    const withPadding = trimmed.endsWith("=") ? trimmed : `${trimmed}=`;
    const key = Buffer.from(withPadding, "base64");
    if (key.length !== CRYPTO.AES_KEY_LENGTH) {
        throw new Error(`invalid encodingAESKey (expected ${CRYPTO.AES_KEY_LENGTH} bytes, got ${key.length})`);
    }
    return key;
}

function pkcs7Pad(buf: Buffer, blockSize: number): Buffer {
    const mod = buf.length % blockSize;
    const pad = mod === 0 ? blockSize : blockSize - mod;
    const padByte = Buffer.from([pad]);
    return Buffer.concat([buf, Buffer.alloc(pad, padByte[0]!)]);
}

export function pkcs7Unpad(buf: Buffer, blockSize: number): Buffer {
    if (buf.length === 0) throw new Error("invalid pkcs7 payload");
    const pad = buf[buf.length - 1]!;
    if (pad < 1 || pad > blockSize) {
        throw new Error("invalid pkcs7 padding");
    }
    if (pad > buf.length) {
        throw new Error("invalid pkcs7 payload");
    }
    for (let i = 0; i < pad; i += 1) {
        if (buf[buf.length - 1 - i] !== pad) {
            throw new Error("invalid pkcs7 padding");
        }
    }
    return buf.subarray(0, buf.length - pad);
}

/**
 * 解密 WeCom 加密消息
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
    const decrypted = pkcs7Unpad(decryptedPadded, CRYPTO.PKCS7_BLOCK_SIZE);

    if (decrypted.length < 20) {
        throw new Error(`invalid payload (expected >=20 bytes, got ${decrypted.length})`);
    }

    // 16 bytes random + 4 bytes length + msg + receiveId
    const msgLen = decrypted.readUInt32BE(16);
    const msgStart = 20;
    const msgEnd = msgStart + msgLen;
    if (msgEnd > decrypted.length) {
        throw new Error(`invalid msg length (msgEnd=${msgEnd}, total=${decrypted.length})`);
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
 * 加密明文为 WeCom 格式
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
    const padded = pkcs7Pad(raw, CRYPTO.PKCS7_BLOCK_SIZE);
    const cipher = crypto.createCipheriv("aes-256-cbc", aesKey, iv);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
    return encrypted.toString("base64");
}

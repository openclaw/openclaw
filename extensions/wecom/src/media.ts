import crypto from "node:crypto";
import { decodeEncodingAESKey, pkcs7Unpad, WECOM_PKCS7_BLOCK_SIZE } from "./crypto.js";
import { readResponseBodyAsBuffer, wecomFetch, type WecomHttpOptions } from "./http.js";

/**
 * **decryptWecomMedia (解密企业微信媒体文件)**
 * 
 * 简易封装：直接传入 URL 和 AES Key 下载并解密。
 * 企业微信媒体文件使用与消息体相同的 AES-256-CBC 加密，IV 为 AES Key 前16字节。
 * 解密后需移除 PKCS#7 填充。
 */
export async function decryptWecomMedia(url: string, encodingAESKey: string, maxBytes?: number): Promise<Buffer> {
    return decryptWecomMediaWithHttp(url, encodingAESKey, { maxBytes });
}

/**
 * **decryptWecomMediaWithHttp (解密企业微信媒体 - 高级)**
 * 
 * 支持传递 HTTP 选项（如 Proxy、Timeout）。
 * 流程：
 * 1. 下载加密内容。
 * 2. 准备 AES Key 和 IV。
 * 3. AES-CBC 解密。
 * 4. PKCS#7 去除填充。
 */
export async function decryptWecomMediaWithHttp(
    url: string,
    encodingAESKey: string,
    params?: { maxBytes?: number; http?: WecomHttpOptions },
): Promise<Buffer> {
    // 1. Download encrypted content
    const res = await wecomFetch(url, undefined, { ...params?.http, timeoutMs: params?.http?.timeoutMs ?? 15_000 });
    if (!res.ok) {
        throw new Error(`failed to download media: ${res.status}`);
    }
    const encryptedData = await readResponseBodyAsBuffer(res, params?.maxBytes);

    // 2. Prepare Key and IV
    const aesKey = decodeEncodingAESKey(encodingAESKey);
    const iv = aesKey.subarray(0, 16);

    // 3. Decrypt
    const decipher = crypto.createDecipheriv("aes-256-cbc", aesKey, iv);
    decipher.setAutoPadding(false); // We handle padding manually
    const decryptedPadded = Buffer.concat([
        decipher.update(encryptedData),
        decipher.final(),
    ]);

    // 4. Unpad
    // Note: Unlike msg bodies, usually removing PKCS#7 padding is enough for media files.
    // The Python SDK logic: pad_len = decrypted_data[-1]; decrypted_data = decrypted_data[:-pad_len]
    // Our pkcs7Unpad function does exactly this + validation.
    return pkcs7Unpad(decryptedPadded, WECOM_PKCS7_BLOCK_SIZE);
}

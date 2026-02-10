import { describe, it, expect, vi } from "vitest";
import { decryptWecomMedia } from "./media.js";
import { WECOM_PKCS7_BLOCK_SIZE } from "./crypto/index.js";
import crypto from "node:crypto";

const { undiciFetch } = vi.hoisted(() => {
    const undiciFetch = vi.fn();
    return { undiciFetch };
});

vi.mock("undici", () => ({
    fetch: undiciFetch,
    ProxyAgent: class ProxyAgent { },
}));

function pkcs7Pad(buf: Buffer, blockSize: number): Buffer {
    const mod = buf.length % blockSize;
    const pad = mod === 0 ? blockSize : blockSize - mod;
    const padByte = Buffer.from([pad]);
    return Buffer.concat([buf, Buffer.alloc(pad, padByte[0]!)]);
}

describe("decryptWecomMedia", () => {
    it("should download and decrypt media successfully", async () => {
        // 1. Setup Key and Data
        const aesKeyBase64 = "jWmYm7qr5nMoCAstdRmNjt3p7vsH8HkK+qiJqQ0aaaa="; // 32 bytes when decoded + padding
        const aesKey = Buffer.from(aesKeyBase64 + "=", "base64");
        const iv = aesKey.subarray(0, 16);

        const originalData = Buffer.from("Hello WeCom Image Data", "utf8");

        // 2. Encrypt manually (AES-256-CBC + PKCS7)
        const padded = pkcs7Pad(originalData, WECOM_PKCS7_BLOCK_SIZE);
        const cipher = crypto.createCipheriv("aes-256-cbc", aesKey, iv);
        cipher.setAutoPadding(false);
        const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);

        // 3. Mock HTTP fetch
        undiciFetch.mockResolvedValue(new Response(encrypted));

        // 4. Test
        const decrypted = await decryptWecomMedia("http://mock.url/image", aesKeyBase64);

        // 5. Assert
        expect(decrypted.toString("utf8")).toBe("Hello WeCom Image Data");
        expect(undiciFetch).toHaveBeenCalledWith(
            "http://mock.url/image",
            expect.objectContaining({ signal: expect.anything() }),
        );
    });

    it("should fail if key is invalid", async () => {
        await expect(decryptWecomMedia("http://url", "invalid-key")).rejects.toThrow();
    });
});

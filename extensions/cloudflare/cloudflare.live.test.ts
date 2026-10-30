import { randomUUID } from "node:crypto";
import type { StorageObjectInfo } from "openclaw/plugin-sdk/plugin-entry";
import { isSecretRef } from "openclaw/plugin-sdk/secret-input";
import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-live";
import { describe, expect, it } from "vitest";
import { r2StorageProvider } from "./api.js";

const accountId = process.env.OPENCLAW_LIVE_R2_ACCOUNT_ID?.trim() ?? "";
const bucket = process.env.OPENCLAW_LIVE_R2_BUCKET?.trim() ?? "";
const accessKeyId = process.env.OPENCLAW_LIVE_R2_ACCESS_KEY_ID?.trim() ?? "";
const secretAccessKey = process.env.OPENCLAW_LIVE_R2_SECRET_ACCESS_KEY?.trim() ?? "";
const sessionToken = process.env.OPENCLAW_LIVE_R2_SESSION_TOKEN?.trim() ?? "";
const describeLive =
  isLiveTestEnabled() && accountId && bucket && accessKeyId && secretAccessKey
    ? describe
    : describe.skip;

async function* bytes(value: Uint8Array): AsyncIterable<Uint8Array> {
  yield value.subarray(0, 5);
  yield value.subarray(5);
}

describeLive("Cloudflare R2 storage live", () => {
  it("round-trips single and multipart objects without overwriting existing keys", async () => {
    const prefix = `openclaw-live/${randomUUID()}`;
    const credentials = new Map([
      ["OPENCLAW_LIVE_R2_ACCESS_KEY_ID", accessKeyId],
      ["OPENCLAW_LIVE_R2_SECRET_ACCESS_KEY", secretAccessKey],
      ["OPENCLAW_LIVE_R2_SESSION_TOKEN", sessionToken],
    ]);
    const backend = await r2StorageProvider.open({
      locationName: "r2-live",
      settings: {
        accountId,
        bucket,
        prefix,
        accessKeyId: { source: "env", provider: "default", id: "OPENCLAW_LIVE_R2_ACCESS_KEY_ID" },
        secretAccessKey: {
          source: "env",
          provider: "default",
          id: "OPENCLAW_LIVE_R2_SECRET_ACCESS_KEY",
        },
        ...(sessionToken
          ? {
              sessionToken: {
                source: "env",
                provider: "default",
                id: "OPENCLAW_LIVE_R2_SESSION_TOKEN",
              },
            }
          : {}),
      },
      resolveSecret: async (ref) => {
        const value = isSecretRef(ref) ? credentials.get(ref.id) : undefined;
        if (!value) {
          throw new Error("R2 live credential reference is unavailable.");
        }
        return value;
      },
    });
    const objects = [
      { key: "known-size.txt", body: Buffer.from("OpenClaw R2 single upload"), knownSize: true },
      {
        key: "unknown-size.txt",
        body: Buffer.from("OpenClaw R2 multipart upload"),
        knownSize: false,
      },
    ];
    const failures: Error[] = [];
    try {
      expect(backend.displayTarget).toBe(`r2://${bucket}/${prefix}`);
      await expect(backend.probe()).resolves.toEqual({});
      for (const object of objects) {
        const options = object.knownSize ? { sizeBytes: object.body.byteLength } : {};
        await expect(backend.putObject(object.key, bytes(object.body), options)).resolves.toEqual({
          sizeBytes: object.body.byteLength,
        });
        const replacement = Buffer.from("This must not replace the original");
        await expect(
          backend.putObject(
            object.key,
            bytes(replacement),
            object.knownSize ? { sizeBytes: replacement.byteLength } : {},
          ),
        ).rejects.toThrow(/already exists|conflict/i);
        await expect(backend.statObject(object.key)).resolves.toMatchObject({
          key: object.key,
          sizeBytes: object.body.byteLength,
        });
        const downloaded = await backend.getObject(object.key);
        expect(downloaded).toBeDefined();
        const chunks: Uint8Array[] = [];
        for await (const chunk of downloaded!) {
          chunks.push(chunk);
        }
        expect(Buffer.concat(chunks)).toEqual(object.body);
      }
      const listed: StorageObjectInfo[] = [];
      for await (const object of backend.listObjects("")) {
        listed.push(object);
      }
      expect(listed).toHaveLength(objects.length);
      expect(listed).toEqual(
        expect.arrayContaining(
          objects.map(({ key, body }) =>
            expect.objectContaining({ key, sizeBytes: body.byteLength }),
          ),
        ),
      );
      for (const { key } of objects) {
        await backend.deleteObject(key);
        await expect(backend.statObject(key)).resolves.toBeUndefined();
        await expect(backend.getObject(key)).resolves.toBeUndefined();
      }
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error("R2 live operation failed."));
    } finally {
      try {
        const cleanup = await Promise.allSettled(
          objects.map(({ key }) => backend.deleteObject(key)),
        );
        if (cleanup.some((result) => result.status === "rejected")) {
          failures.push(
            new Error(
              `R2 live cleanup failed; remove test objects under r2://${bucket}/${prefix}.`,
            ),
          );
        }
      } finally {
        try {
          await backend.close?.();
        } catch {
          failures.push(new Error("R2 live client cleanup failed."));
        }
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "R2 live storage test failed.");
    }
  }, 120_000);
});

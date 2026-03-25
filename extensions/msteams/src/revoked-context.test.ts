import { describe, expect, it, vi } from "vitest";
import { withRevokedProxyFallback } from "./revoked-context.js";

describe("msteams revoked context helper", () => {
  it("returns primary result when no error occurs", async () => {
    await expect(
      withRevokedProxyFallback({
        run: async () => "ok",
        onRevoked: async () => "fallback",
      }),
    ).resolves.toBe("ok");
  });

  it("uses fallback when proxy-revoked TypeError is thrown", async () => {
    const onRevokedLog = vi.fn();
    await expect(
      withRevokedProxyFallback({
        run: async () => {
          throw new TypeError("Cannot perform 'get' on a proxy that has been revoked");
        },
        onRevoked: async () => "fallback",
        onRevokedLog,
      }),
    ).resolves.toBe("fallback");
    expect(onRevokedLog).toHaveBeenCalledOnce();
  });

  it("rethrows non-revoked errors", async () => {
    const err = Object.assign(new Error("boom"), { statusCode: 500 });
    await expect(
      withRevokedProxyFallback({
        run: async () => {
          throw err;
        },
        onRevoked: async () => "fallback",
      }),
    ).rejects.toBe(err);
  });
});

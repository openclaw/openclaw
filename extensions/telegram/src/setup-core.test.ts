import { describe, expect, it, vi } from "vitest";
import { resolveTelegramAllowFromEntries } from "./setup-core.js";

describe("resolveTelegramAllowFromEntries", () => {
  it("passes apiRoot through username lookups", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ ok: true, result: { id: 12345 } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const resolved = await resolveTelegramAllowFromEntries({
        entries: ["@user"],
        credentialValue: "tok",
        apiRoot: "https://custom.telegram.test/root/",
      });

      expect(resolved).toEqual([{ input: "@user", resolved: true, id: "12345" }]);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://custom.telegram.test/root/bottok/getChat?chat_id=%40user",
        undefined,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

import { describe, expect, it } from "vitest";

describe("zalo runtime api", () => {
  it("exports the channel plugin without reentering setup surfaces", async () => {
    const runtimeApi = await import("./runtime-api.js");

    expect(runtimeApi.zaloPlugin.id).toBe("zalo");
  });
});

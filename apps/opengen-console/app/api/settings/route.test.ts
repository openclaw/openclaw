import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("settings route", () => {
  it("returns model diagnostics without exposing secrets", async () => {
    const res = await GET();
    const json = await res.json();
    expect(json).toHaveProperty("provider");
    expect(json).not.toHaveProperty("api_key");
  });
});

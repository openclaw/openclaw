import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("health route", () => {
  it("returns ok", async () => {
    const res = await GET();
    const json = await res.json();
    expect(json.status).toBe("ok");
  });
});

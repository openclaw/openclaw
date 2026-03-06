import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("tasks route", () => {
  it("returns task list payload", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { items?: unknown[] };
    expect(Array.isArray(json.items)).toBe(true);
  });
});

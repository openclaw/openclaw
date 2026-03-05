import { describe, expect, it } from "vitest";
import { POST } from "./route";

describe("generate route", () => {
  it("returns 400 for invalid payload", async () => {
    const req = new Request("http://localhost/api/generate", {
      method: "POST",
      body: JSON.stringify({ description: "" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

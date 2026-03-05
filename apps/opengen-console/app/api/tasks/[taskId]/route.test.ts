import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("task detail route", () => {
  it("returns 404 when task does not exist", async () => {
    const req = new Request("http://localhost/api/tasks/missing");
    const res = await GET(req, { params: Promise.resolve({ taskId: "missing" }) });
    expect(res.status).toBe(404);
  });
});

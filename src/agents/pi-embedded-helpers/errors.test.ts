import { describe, expect, it } from "vitest";
import { classifyFailoverReason } from "./errors.js";

describe("classifyFailoverReason", () => {
  it("classifies zhipuai Weekly/Monthly Limit Exhausted as rate_limit", () => {
    const msg =
      "Error 1310: Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-03-06 22:19:54";
    expect(classifyFailoverReason(msg)).toBe("rate_limit");
  });

  it("classifies 'limit exhausted' as rate_limit", () => {
    expect(classifyFailoverReason("Weekly limit exhausted")).toBe("rate_limit");
  });
});

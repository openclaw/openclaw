import { describe, expect, it } from "vitest";
import { classifyFailoverReason } from "./errors.js";

describe("classifyFailoverReason", () => {
  it("classifies the expanded failover reason taxonomy", () => {
    expect(classifyFailoverReason("unknown model: openai/not-real")).toBe("unknown_model");
    expect(classifyFailoverReason("resource not found")).toBe("not_found");
    expect(classifyFailoverReason("invalid api key")).toBe("auth");
    expect(classifyFailoverReason("429 too many requests")).toBe("rate_limit");
    expect(classifyFailoverReason("503 service unavailable")).toBe("server");
    expect(classifyFailoverReason("408 request timeout")).toBe("timeout");
    expect(classifyFailoverReason("502 bad gateway")).toBe("transport");
    expect(classifyFailoverReason("payment required")).toBe("billing");
    expect(classifyFailoverReason("400 bad request")).toBe("bad_request");
    expect(classifyFailoverReason("451 unavailable for legal reasons")).toBe("policy");
    expect(classifyFailoverReason("499 client closed request")).toBe("cancelled");
    expect(classifyFailoverReason("invalid request format")).toBe("format");
    expect(classifyFailoverReason("gibberish")).toBeNull();
  });

  it("does not classify generic policy mentions as policy failures", () => {
    expect(classifyFailoverReason("CORS policy blocked the request")).toBeNull();
    expect(classifyFailoverReason("retry policy exhausted")).toBeNull();
    expect(classifyFailoverReason("cache policy prevented write")).toBeNull();
  });

  it("still classifies explicit policy failures", () => {
    expect(classifyFailoverReason("content policy violation")).toBe("policy");
    expect(classifyFailoverReason("HTTP 451 unavailable for legal reasons")).toBe("policy");
  });

  it("does not classify ambiguous safety-system wording as policy", () => {
    expect(classifyFailoverReason("safety system temporarily unavailable")).toBe("server");
    expect(classifyFailoverReason("safety system check failed")).toBeNull();
  });
});

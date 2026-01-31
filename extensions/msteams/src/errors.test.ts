import { describe, expect, it } from "vitest";

import {
  classifyMSTeamsSendError,
  formatMSTeamsSendErrorHint,
  formatUnknownError,
} from "./errors.js";

describe("msteams errors", () => {
  it("formats unknown errors", () => {
    expect(formatUnknownError("oops")).toBe("oops");
    expect(formatUnknownError(null)).toBe("null");
  });

  it("classifies auth errors", () => {
    expect(classifyMSTeamsSendError({ statusCode: 401 }).kind).toBe("auth");
    expect(classifyMSTeamsSendError({ statusCode: 403 }).kind).toBe("auth");
  });

  it("classifies throttling errors and parses retry-after", () => {
    expect(classifyMSTeamsSendError({ statusCode: 429, retryAfter: "1.5" })).toMatchObject({
      kind: "throttled",
      statusCode: 429,
      retryAfterMs: 1500,
    });
  });

  it("classifies transient errors", () => {
    expect(classifyMSTeamsSendError({ statusCode: 503 })).toMatchObject({
      kind: "transient",
      statusCode: 503,
    });
  });

  it("classifies permanent 4xx errors", () => {
    expect(classifyMSTeamsSendError({ statusCode: 400 })).toMatchObject({
      kind: "permanent",
      statusCode: 400,
    });
  });

  it("provides actionable hints for common cases", () => {
    expect(formatMSTeamsSendErrorHint({ kind: "auth" })).toContain("msteams");
    expect(formatMSTeamsSendErrorHint({ kind: "throttled" })).toContain("throttled");
  });
});

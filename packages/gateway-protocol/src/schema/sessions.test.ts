import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { SessionsEchoParamsSchema } from "./sessions.js";

describe("SessionsEchoParamsSchema threadId", () => {
  const base = {
    key: "agent:main:telegram:direct:123:thread:123:67",
    action: "add",
    channel: "telegram",
    to: "123",
  };

  it("accepts a numeric threadId (Telegram forum thread ids arrive as numbers)", () => {
    expect(Value.Check(SessionsEchoParamsSchema, { ...base, threadId: 26237 })).toBe(true);
  });

  it("accepts a string threadId", () => {
    expect(Value.Check(SessionsEchoParamsSchema, { ...base, threadId: "26237" })).toBe(true);
  });

  it("omits threadId (optional)", () => {
    expect(Value.Check(SessionsEchoParamsSchema, base)).toBe(true);
  });

  it("rejects a threadId that is neither string nor number", () => {
    expect(Value.Check(SessionsEchoParamsSchema, { ...base, threadId: true })).toBe(false);
  });
});

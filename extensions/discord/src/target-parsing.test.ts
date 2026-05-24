import { describe, it, expect } from "vitest";
import { parseDiscordTarget } from "./target-parsing.js";

describe("parseDiscordTarget", () => {
  it("accepts bare numeric ID as channel when defaultKind is channel", () => {
    const target = parseDiscordTarget("123456789012345678", { defaultKind: "channel" });
    expect(target).toBeDefined();
    expect(target!.kind).toBe("channel");
    expect(target!.id).toBe("123456789012345678");
  });

  it("accepts bare numeric ID as user when defaultKind is user", () => {
    const target = parseDiscordTarget("123456789012345678", { defaultKind: "user" });
    expect(target).toBeDefined();
    expect(target!.kind).toBe("user");
    expect(target!.id).toBe("123456789012345678");
  });

  it("throws ambiguous error for bare numeric ID without defaultKind", () => {
    expect(() => parseDiscordTarget("123456789012345678")).toThrow(
      'Ambiguous Discord recipient "123456789012345678"',
    );
  });

  it("accepts channel: prefixed ID without defaultKind", () => {
    const target = parseDiscordTarget("channel:123456789012345678");
    expect(target).toBeDefined();
    expect(target!.kind).toBe("channel");
    expect(target!.id).toBe("123456789012345678");
  });

  it("accepts user: prefixed ID without defaultKind", () => {
    const target = parseDiscordTarget("user:123456789012345678");
    expect(target).toBeDefined();
    expect(target!.kind).toBe("user");
    expect(target!.id).toBe("123456789012345678");
  });

  it("accepts <@id> mention as user", () => {
    const target = parseDiscordTarget("<@123456789012345678>");
    expect(target).toBeDefined();
    expect(target!.kind).toBe("user");
    expect(target!.id).toBe("123456789012345678");
  });

  it("accepts non-numeric bare ID as channel", () => {
    const target = parseDiscordTarget("#general");
    expect(target).toBeDefined();
    expect(target!.kind).toBe("channel");
    expect(target!.id).toBe("#general");
  });
});

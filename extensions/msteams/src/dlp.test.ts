import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { redactOutboundMSTeamsCard, redactText } from "./dlp.js";

const on = (extra?: Record<string, unknown>) => ({ enabled: true, ...extra });

describe("dlp redactText (#16)", () => {
  it("is a no-op when disabled or empty", () => {
    expect(redactText("card 4111 1111 1111 1111", { enabled: false }).text).toBe(
      "card 4111 1111 1111 1111",
    );
    expect(redactText("", on()).text).toBe("");
  });

  it("redacts a Luhn-valid credit card but not a random 16-digit number", () => {
    // 4111111111111111 is the canonical Luhn-valid test card.
    const valid = redactText("pay 4111 1111 1111 1111 now", on());
    expect(valid.text).toBe("pay [REDACTED:creditCard] now");
    expect(valid.redactions).toContainEqual({ category: "creditCard", count: 1 });

    // A 16-digit number that fails Luhn is left alone.
    expect(redactText("ref 1234 5678 9012 3456", on()).text).toBe("ref 1234 5678 9012 3456");
  });

  it("redacts emails, SSNs, AWS keys, and provider secrets", () => {
    expect(redactText("mail me at a.b@example.com", on()).text).toBe("mail me at [REDACTED:email]");
    expect(redactText("ssn 123-45-6789", on()).text).toBe("ssn [REDACTED:ssn]");
    expect(redactText("key AKIAIOSFODNN7EXAMPLE here", on()).text).toBe(
      "key [REDACTED:awsKey] here",
    );
    expect(redactText("token sk-abcdefghijklmnopqrstuvwx", on()).text).toBe(
      "token [REDACTED:secret]",
    );
    expect(redactText("gh ghp_abcdefghijklmnopqrstuvwxyz0123456789", on()).text).toBe(
      "gh [REDACTED:secret]",
    );
  });

  it("honors the categories filter (only redacts enabled built-ins)", () => {
    const out = redactText("a.b@example.com and 123-45-6789", on({ categories: ["ssn"] }));
    expect(out.text).toBe("a.b@example.com and [REDACTED:ssn]");
  });

  it("applies custom patterns (taking precedence) and a custom placeholder", () => {
    const out = redactText("employee EMP-00042 badge", {
      enabled: true,
      categories: [],
      customPatterns: [{ name: "empId", pattern: "EMP-\\d{5}" }],
      placeholder: "‹{category}›",
    });
    expect(out.text).toBe("employee ‹empId› badge");
    expect(out.redactions).toContainEqual({ category: "empId", count: 1 });
  });

  it("skips a malformed custom pattern instead of throwing", () => {
    const out = redactText("hello", on({ customPatterns: [{ name: "bad", pattern: "(" }] }));
    expect(out.text).toBe("hello");
  });

  it("counts multiple hits per category", () => {
    const out = redactText("a@x.com, b@y.com", on({ categories: ["email"] }));
    expect(out.redactions).toContainEqual({ category: "email", count: 2 });
  });

  it("redacts segmented provider keys — sk-proj-/sk-ant- (S5)", () => {
    expect(redactText(`key sk-proj-${"Ab1".repeat(10)} here`, on()).text).toBe(
      "key [REDACTED:secret] here",
    );
    expect(redactText(`key sk-ant-api03-${"Xy9_".repeat(8)}end`, on()).text).toBe(
      "key [REDACTED:secret]",
    );
  });
});

describe("dlp redactOutboundMSTeamsCard (S3)", () => {
  const cardCfg = (enabled: boolean): OpenClawConfig =>
    ({ channels: { msteams: { dlp: { enabled } } } }) as unknown as OpenClawConfig;

  it("deep-redacts every string value in an outbound card without mutating the original", () => {
    const card = {
      type: "AdaptiveCard",
      body: [{ type: "TextBlock", text: `the key is sk-${"a".repeat(24)}` }],
      actions: [
        { type: "Action.OpenUrl", title: "contact a.b@example.com", url: "https://x.test" },
      ],
    };
    const out = redactOutboundMSTeamsCard(card, cardCfg(true));
    const json = JSON.stringify(out);
    expect(json).not.toContain("sk-");
    expect(json).not.toContain("a.b@example.com");
    expect(json).toContain("[REDACTED:secret]");
    expect(json).toContain("[REDACTED:email]");
    // Structural fields survive; the input card is untouched.
    expect(out.type).toBe("AdaptiveCard");
    expect(card.body[0]?.text).toContain("sk-");
  });

  it("is a no-op (same reference) when DLP is off", () => {
    const card = { body: [{ text: `sk-${"a".repeat(24)}` }] };
    expect(redactOutboundMSTeamsCard(card, cardCfg(false))).toBe(card);
  });
});

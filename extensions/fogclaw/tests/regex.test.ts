import { describe, it, expect } from "vitest";
import { RegexEngine } from "../src/engines/regex.js";

const engine = new RegexEngine();

/** Helper: assert every returned entity has correct span offsets */
function assertSpans(text: string) {
  const entities = engine.scan(text);
  for (const e of entities) {
    expect(text.slice(e.start, e.end)).toBe(e.text);
  }
  return entities;
}

// ---------------------------------------------------------------------------
// EMAIL
// ---------------------------------------------------------------------------
describe("EMAIL", () => {
  it("detects a simple email", () => {
    const entities = assertSpans("Contact alice@example.com for info.");
    const emails = entities.filter((e) => e.label === "EMAIL");
    expect(emails).toHaveLength(1);
    expect(emails[0].text).toBe("alice@example.com");
    expect(emails[0].confidence).toBe(1.0);
    expect(emails[0].source).toBe("regex");
  });

  it("detects email with subdomains", () => {
    const entities = assertSpans("Send to bob@mail.example.co.uk now");
    const emails = entities.filter((e) => e.label === "EMAIL");
    expect(emails).toHaveLength(1);
    expect(emails[0].text).toBe("bob@mail.example.co.uk");
  });

  it("detects email with special chars in local part", () => {
    const entities = assertSpans("user+tag@example.org");
    const emails = entities.filter((e) => e.label === "EMAIL");
    expect(emails).toHaveLength(1);
    expect(emails[0].text).toBe("user+tag@example.org");
  });

  it("does not match bare @-signs or partial addresses", () => {
    const entities = engine.scan("@ or foo@ or @bar");
    const emails = entities.filter((e) => e.label === "EMAIL");
    expect(emails).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PHONE
// ---------------------------------------------------------------------------
describe("PHONE", () => {
  it("detects US phone with dashes", () => {
    const entities = assertSpans("Call 555-123-4567 today.");
    const phones = entities.filter((e) => e.label === "PHONE");
    expect(phones).toHaveLength(1);
    expect(phones[0].text).toBe("555-123-4567");
  });

  it("detects US phone with parentheses", () => {
    const entities = assertSpans("Phone: (555) 123-4567");
    const phones = entities.filter((e) => e.label === "PHONE");
    expect(phones).toHaveLength(1);
    expect(phones[0].text).toBe("(555) 123-4567");
  });

  it("detects +1 prefix", () => {
    const entities = assertSpans("Reach me at +1-800-555-1234.");
    const phones = entities.filter((e) => e.label === "PHONE");
    expect(phones).toHaveLength(1);
    expect(phones[0].text).toBe("+1-800-555-1234");
  });

  it("detects international format", () => {
    const entities = assertSpans("Number: +44 20 7946 0958");
    const phones = entities.filter((e) => e.label === "PHONE");
    expect(phones).toHaveLength(1);
    expect(phones[0].text).toBe("+44 20 7946 0958");
  });

  it("does not match short digit sequences", () => {
    const entities = engine.scan("Code 12345 here");
    const phones = entities.filter((e) => e.label === "PHONE");
    expect(phones).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// SSN
// ---------------------------------------------------------------------------
describe("SSN", () => {
  it("detects a valid SSN with dashes", () => {
    const entities = assertSpans("SSN: 123-45-6789");
    const ssns = entities.filter((e) => e.label === "SSN");
    expect(ssns).toHaveLength(1);
    expect(ssns[0].text).toBe("123-45-6789");
  });

  it("detects a valid SSN without dashes", () => {
    const entities = assertSpans("SSN 123456789 filed.");
    const ssns = entities.filter((e) => e.label === "SSN");
    expect(ssns).toHaveLength(1);
    expect(ssns[0].text).toBe("123456789");
  });

  it("rejects SSN starting with 000", () => {
    const entities = engine.scan("Invalid SSN 000-12-3456");
    const ssns = entities.filter((e) => e.label === "SSN");
    expect(ssns).toHaveLength(0);
  });

  it("rejects SSN starting with 666", () => {
    const entities = engine.scan("Invalid SSN 666-12-3456");
    const ssns = entities.filter((e) => e.label === "SSN");
    expect(ssns).toHaveLength(0);
  });

  it("rejects SSN with 00 in middle group", () => {
    const entities = engine.scan("Invalid SSN 123-00-6789");
    const ssns = entities.filter((e) => e.label === "SSN");
    expect(ssns).toHaveLength(0);
  });

  it("rejects SSN with 0000 in last group", () => {
    const entities = engine.scan("Invalid SSN 123-45-0000");
    const ssns = entities.filter((e) => e.label === "SSN");
    expect(ssns).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// CREDIT_CARD
// ---------------------------------------------------------------------------
describe("CREDIT_CARD", () => {
  it("detects a Visa card (16 digits)", () => {
    const entities = assertSpans("Card: 4111111111111111");
    const cards = entities.filter((e) => e.label === "CREDIT_CARD");
    expect(cards).toHaveLength(1);
    expect(cards[0].text).toBe("4111111111111111");
  });

  it("detects a Mastercard", () => {
    const entities = assertSpans("MC 5500000000000004");
    const cards = entities.filter((e) => e.label === "CREDIT_CARD");
    expect(cards).toHaveLength(1);
    expect(cards[0].text).toBe("5500000000000004");
  });

  it("detects an Amex card", () => {
    const entities = assertSpans("Amex 378282246310005");
    const cards = entities.filter((e) => e.label === "CREDIT_CARD");
    expect(cards).toHaveLength(1);
    expect(cards[0].text).toBe("378282246310005");
  });

  it("detects card number with dashes", () => {
    const entities = assertSpans("Card 4111-1111-1111-1111 charged");
    const cards = entities.filter((e) => e.label === "CREDIT_CARD");
    expect(cards).toHaveLength(1);
    expect(cards[0].text).toBe("4111-1111-1111-1111");
  });

  it("detects card number with spaces", () => {
    const entities = assertSpans("Card 5500 0000 0000 0004 charged");
    const cards = entities.filter((e) => e.label === "CREDIT_CARD");
    expect(cards).toHaveLength(1);
    expect(cards[0].text).toBe("5500 0000 0000 0004");
  });
});

// ---------------------------------------------------------------------------
// IP_ADDRESS
// ---------------------------------------------------------------------------
describe("IP_ADDRESS", () => {
  it("detects a valid IPv4 address", () => {
    const entities = assertSpans("Server at 192.168.1.1 is up.");
    const ips = entities.filter((e) => e.label === "IP_ADDRESS");
    expect(ips).toHaveLength(1);
    expect(ips[0].text).toBe("192.168.1.1");
  });

  it("detects 0.0.0.0", () => {
    const entities = assertSpans("Bind to 0.0.0.0 for all interfaces.");
    const ips = entities.filter((e) => e.label === "IP_ADDRESS");
    expect(ips).toHaveLength(1);
    expect(ips[0].text).toBe("0.0.0.0");
  });

  it("detects 255.255.255.255", () => {
    const entities = assertSpans("Broadcast: 255.255.255.255");
    const ips = entities.filter((e) => e.label === "IP_ADDRESS");
    expect(ips).toHaveLength(1);
    expect(ips[0].text).toBe("255.255.255.255");
  });

  it("rejects IP with octet > 255", () => {
    const entities = engine.scan("Invalid 256.1.2.3 address");
    const ips = entities.filter((e) => e.label === "IP_ADDRESS");
    // Should not match 256.1.2.3 as a complete valid IP
    for (const ip of ips) {
      expect(ip.text).not.toBe("256.1.2.3");
    }
  });

  it("rejects IP with octet 999", () => {
    const entities = engine.scan("Bad IP 999.999.999.999");
    const ips = entities.filter((e) => e.label === "IP_ADDRESS");
    for (const ip of ips) {
      expect(ip.text).not.toBe("999.999.999.999");
    }
  });
});

// ---------------------------------------------------------------------------
// DATE
// ---------------------------------------------------------------------------
describe("DATE", () => {
  it("detects MM/DD/YYYY format", () => {
    const entities = assertSpans("Born on 01/15/1990 in NY.");
    const dates = entities.filter((e) => e.label === "DATE");
    expect(dates).toHaveLength(1);
    expect(dates[0].text).toBe("01/15/1990");
  });

  it("detects YYYY-MM-DD format", () => {
    const entities = assertSpans("Date: 2024-03-15 confirmed.");
    const dates = entities.filter((e) => e.label === "DATE");
    expect(dates).toHaveLength(1);
    expect(dates[0].text).toBe("2024-03-15");
  });

  it("detects Month DD, YYYY format", () => {
    const entities = assertSpans("On January 5, 2023 we met.");
    const dates = entities.filter((e) => e.label === "DATE");
    expect(dates).toHaveLength(1);
    expect(dates[0].text).toBe("January 5, 2023");
  });

  it("detects abbreviated month", () => {
    const entities = assertSpans("Meeting: Dec 25, 2022 at noon.");
    const dates = entities.filter((e) => e.label === "DATE");
    expect(dates).toHaveLength(1);
    expect(dates[0].text).toBe("Dec 25, 2022");
  });

  it("detects MM-DD-YY format", () => {
    const entities = assertSpans("Filed 03-15-90 in records.");
    const dates = entities.filter((e) => e.label === "DATE");
    expect(dates).toHaveLength(1);
    expect(dates[0].text).toBe("03-15-90");
  });
});

// ---------------------------------------------------------------------------
// ZIP_CODE
// ---------------------------------------------------------------------------
describe("ZIP_CODE", () => {
  it("detects a 5-digit ZIP", () => {
    const entities = assertSpans("ZIP 90210 area.");
    const zips = entities.filter((e) => e.label === "ZIP_CODE");
    expect(zips).toHaveLength(1);
    expect(zips[0].text).toBe("90210");
  });

  it("detects a ZIP+4", () => {
    const entities = assertSpans("Mailing: 90210-1234 confirmed.");
    const zips = entities.filter((e) => e.label === "ZIP_CODE");
    expect(zips).toHaveLength(1);
    expect(zips[0].text).toBe("90210-1234");
  });
});

// ---------------------------------------------------------------------------
// COMBINED / EDGE CASES
// ---------------------------------------------------------------------------
describe("Multiple entities in one text", () => {
  it("finds email, phone, and SSN in same text", () => {
    const text =
      "Contact alice@example.com or 555-123-4567. SSN: 123-45-6789.";
    const entities = assertSpans(text);

    const labels = entities.map((e) => e.label);
    expect(labels).toContain("EMAIL");
    expect(labels).toContain("PHONE");
    expect(labels).toContain("SSN");
  });

  it("finds multiple emails", () => {
    const text = "Send to a@b.com and c@d.org please.";
    const entities = assertSpans(text);
    const emails = entities.filter((e) => e.label === "EMAIL");
    expect(emails).toHaveLength(2);
    expect(emails[0].text).toBe("a@b.com");
    expect(emails[1].text).toBe("c@d.org");
  });
});

describe("Empty and no-match inputs", () => {
  it("returns empty array for empty string", () => {
    const entities = engine.scan("");
    expect(entities).toEqual([]);
  });

  it("returns empty array for text with no PII", () => {
    const entities = engine.scan("The quick brown fox jumps over the lazy dog.");
    // Filter out anything that might false-positive
    const meaningful = entities.filter(
      (e) => !["ZIP_CODE"].includes(e.label) || e.text.length >= 5
    );
    // This sentence has no PII
    expect(entities).toEqual([]);
  });
});

describe("Entity shape", () => {
  it("every entity has correct confidence and source", () => {
    const text = "Email: test@test.com Phone: 555-123-4567";
    const entities = engine.scan(text);
    for (const e of entities) {
      expect(e.confidence).toBe(1.0);
      expect(e.source).toBe("regex");
      expect(typeof e.start).toBe("number");
      expect(typeof e.end).toBe("number");
      expect(e.end).toBeGreaterThan(e.start);
      expect(typeof e.text).toBe("string");
      expect(typeof e.label).toBe("string");
    }
  });

  it("span offsets are correct for all entity types", () => {
    const text =
      "Email: user@site.com, Phone: (800) 555-0199, SSN: 321-54-9876, " +
      "Card: 4111111111111111, IP: 10.0.0.1, Date: 2024-06-15, ZIP: 60601";
    assertSpans(text);
  });
});

describe("Repeated scan calls (lastIndex reset)", () => {
  it("produces the same results on consecutive calls", () => {
    const text = "Email alice@example.com and call 555-123-4567.";
    const first = engine.scan(text);
    const second = engine.scan(text);
    expect(first).toEqual(second);
  });
});

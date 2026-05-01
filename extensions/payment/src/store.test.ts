import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendAuditRecord,
  expandStorePath,
  handleMap,
  readAuditRecords,
  redactSensitiveValue,
} from "./store.js";
import type { AuditRecord, HandleMetadata } from "./store.js";

// ---------------------------------------------------------------------------
// redactSensitiveValue tests
// ---------------------------------------------------------------------------

describe("redactSensitiveValue — PAN redaction", () => {
  it("redacts a Luhn-valid PAN string at the top level", () => {
    // 4242424242424242 is a standard Luhn-valid test PAN
    expect(redactSensitiveValue("4242424242424242")).toBe("[REDACTED]");
  });

  it("redacts a Luhn-valid PAN with spaces", () => {
    expect(redactSensitiveValue("4242 4242 4242 4242")).toBe("[REDACTED]");
  });

  it("redacts a PAN nested inside an object", () => {
    const result = redactSensitiveValue({
      cardNumber: "4242424242424242",
      amount: 100,
    }) as Record<string, unknown>;
    expect(result["cardNumber"]).toBe("[REDACTED]");
    expect(result["amount"]).toBe(100);
  });

  it("redacts PANs nested inside arrays", () => {
    const result = redactSensitiveValue(["4242424242424242", "hello"]) as unknown[];
    expect(result[0]).toBe("[REDACTED]");
    expect(result[1]).toBe("hello");
  });

  it("redacts a PAN in a deeply nested object", () => {
    const result = redactSensitiveValue({
      payment: {
        card: {
          pan: "4242424242424242",
        },
      },
    }) as { payment: { card: { pan: string } } };
    expect(result.payment.card.pan).toBe("[REDACTED]");
  });
});

describe("redactSensitiveValue — CVV redaction", () => {
  it("redacts string value at a 'cvv' key", () => {
    const result = redactSensitiveValue({ cvv: "123" }) as Record<string, unknown>;
    expect(result["cvv"]).toBe("[REDACTED]");
  });

  it("redacts string value at a 'cvc' key", () => {
    const result = redactSensitiveValue({ cvc: "456" }) as Record<string, unknown>;
    expect(result["cvc"]).toBe("[REDACTED]");
  });

  it("redacts string value at a 'cvv2' key", () => {
    const result = redactSensitiveValue({ cvv2: "789" }) as Record<string, unknown>;
    expect(result["cvv2"]).toBe("[REDACTED]");
  });

  it("redacts string value at a 'cvc2' key", () => {
    const result = redactSensitiveValue({ cvc2: "012" }) as Record<string, unknown>;
    expect(result["cvc2"]).toBe("[REDACTED]");
  });

  it("does NOT redact a non-cvv-key field with a 3-digit string", () => {
    const result = redactSensitiveValue({ amount: "123" }) as Record<string, unknown>;
    expect(result["amount"]).toBe("123");
  });
});

describe("redactSensitiveValue — Authorization header redaction", () => {
  it("redacts 'Payment ...' Authorization header value", () => {
    const result = redactSensitiveValue({
      authorization: "Payment tok_abc123",
    }) as Record<string, unknown>;
    expect(result["authorization"]).toBe("[REDACTED]");
  });

  it("does NOT redact 'Bearer ...' Authorization header value", () => {
    const result = redactSensitiveValue({
      authorization: "Bearer some-jwt-token",
    }) as Record<string, unknown>;
    expect(result["authorization"]).toBe("Bearer some-jwt-token");
  });
});

describe("redactSensitiveValue — non-card numeric strings NOT redacted", () => {
  it("does not redact a dollar amount string", () => {
    // "12345" — short and not Luhn-valid as PAN (only 5 digits, under 13)
    expect(redactSensitiveValue("12345")).toBe("12345");
  });

  it("does not redact a Stripe spend-request id (not Luhn-valid PAN shape)", () => {
    // Stripe spend request IDs are alphanumeric, not PAN-shaped
    const spendId = "spend_req_abc123def456";
    expect(redactSensitiveValue(spendId)).toBe(spendId);
  });

  it("does not redact a 16-digit string that fails Luhn", () => {
    // 1234567890123456 — 16 digits but Luhn-invalid
    expect(redactSensitiveValue("1234567890123456")).toBe("1234567890123456");
  });
});

describe("redactSensitiveValue — primitive/non-object inputs", () => {
  it("returns a plain string unchanged when not PAN-shaped", () => {
    expect(redactSensitiveValue("hello world")).toBe("hello world");
  });

  it("returns a number unchanged", () => {
    expect(redactSensitiveValue(42)).toBe(42);
  });

  it("returns null unchanged", () => {
    expect(redactSensitiveValue(null)).toBeNull();
  });

  it("returns undefined unchanged", () => {
    expect(redactSensitiveValue(undefined)).toBeUndefined();
  });

  it("returns boolean unchanged", () => {
    expect(redactSensitiveValue(true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// appendAuditRecord / readAuditRecords tests
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    openclawPaymentId: "pay_test_001",
    providerId: "mock",
    status: "pending",
    timestamps: { createdAt: new Date().toISOString() },
    ...overrides,
  };
}

describe("appendAuditRecord / readAuditRecords", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "payment-store-test-"));
    storePath = path.join(tmpDir, "audit.jsonl");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes a JSON line that round-trips through readAuditRecords", async () => {
    const record = makeRecord({ openclawPaymentId: "pay_round_trip" });
    await appendAuditRecord(storePath, record);
    const records = await readAuditRecords(storePath);
    expect(records).toHaveLength(1);
    expect(records[0]?.openclawPaymentId).toBe("pay_round_trip");
    expect(records[0]?.providerId).toBe("mock");
    expect(records[0]?.status).toBe("pending");
  });

  it("appends multiple records correctly", async () => {
    await appendAuditRecord(storePath, makeRecord({ openclawPaymentId: "pay_001" }));
    await appendAuditRecord(storePath, makeRecord({ openclawPaymentId: "pay_002" }));
    const records = await readAuditRecords(storePath);
    expect(records).toHaveLength(2);
    expect(records[0]?.openclawPaymentId).toBe("pay_001");
    expect(records[1]?.openclawPaymentId).toBe("pay_002");
  });

  it("redacts PAN in an unexpected field before writing", async () => {
    // Pass a record with a PAN buried in a random field (simulating accidental PAN leak)
    const record = makeRecord({
      // @ts-expect-error — intentionally injecting a disallowed field for redaction test
      unexpectedPan: "4242424242424242",
    });
    await appendAuditRecord(storePath, record);

    const raw = await fs.readFile(storePath, "utf8");
    expect(raw).not.toContain("4242424242424242");
    expect(raw).toContain("[REDACTED]");

    const records = await readAuditRecords(storePath);
    expect((records[0] as Record<string, unknown>)["unexpectedPan"]).toBe("[REDACTED]");
  });

  it("readAuditRecords returns empty array if file does not exist", async () => {
    const records = await readAuditRecords(path.join(tmpDir, "nonexistent.jsonl"));
    expect(records).toEqual([]);
  });

  it("readAuditRecords skips malformed lines with a console.warn", async () => {
    // Write one valid and one malformed line
    await fs.writeFile(
      storePath,
      `${JSON.stringify(makeRecord({ openclawPaymentId: "pay_valid" }))}\nnot-json-at-all\n`,
      "utf8",
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const records = await readAuditRecords(storePath);

    expect(records).toHaveLength(1);
    expect(records[0]?.openclawPaymentId).toBe("pay_valid");
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it("creates parent directories automatically", async () => {
    const nestedPath = path.join(tmpDir, "nested", "deep", "audit.jsonl");
    await appendAuditRecord(nestedPath, makeRecord());
    const records = await readAuditRecords(nestedPath);
    expect(records).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// expandStorePath tests
// ---------------------------------------------------------------------------

describe("expandStorePath", () => {
  it("expands '~' prefix to home directory", () => {
    const expanded = expandStorePath("~/.openclaw/payments");
    expect(expanded).toBe(path.join(os.homedir(), ".openclaw/payments"));
  });

  it("leaves an absolute path unchanged (still resolves)", () => {
    const abs = "/tmp/openclaw/audit.jsonl";
    expect(expandStorePath(abs)).toBe(abs);
  });

  it("resolves a relative path to an absolute path", () => {
    const expanded = expandStorePath("relative/path");
    expect(path.isAbsolute(expanded)).toBe(true);
    expect(expanded).toContain("relative/path");
  });

  it("handles bare '~' correctly", () => {
    expect(expandStorePath("~")).toBe(os.homedir());
  });
});

// ---------------------------------------------------------------------------
// handleMap tests
// ---------------------------------------------------------------------------

describe("handleMap", () => {
  // Reset the internal map between tests to avoid cross-test pollution
  beforeEach(() => {
    // Clear by deleting all entries
    for (const id of [...handleMap._map.keys()]) {
      handleMap.delete(id);
    }
  });

  const sampleMeta: HandleMetadata = {
    spendRequestId: "spend_req_test_001",
    last4: "4242",
    targetMerchantName: "Acme Corp",
    issuedAt: "2026-04-30T00:00:00.000Z",
    validUntil: "2026-05-01T00:00:00.000Z",
  };

  it("set and get round-trip", () => {
    handleMap.set("handle_001", sampleMeta);
    expect(handleMap.get("handle_001")).toEqual(sampleMeta);
  });

  it("returns undefined for unknown handleId", () => {
    expect(handleMap.get("handle_unknown")).toBeUndefined();
  });

  it("delete removes the entry", () => {
    handleMap.set("handle_002", sampleMeta);
    handleMap.delete("handle_002");
    expect(handleMap.get("handle_002")).toBeUndefined();
  });

  it("size returns the current entry count", () => {
    expect(handleMap.size()).toBe(0);
    handleMap.set("handle_003", sampleMeta);
    expect(handleMap.size()).toBe(1);
    handleMap.set("handle_004", sampleMeta);
    expect(handleMap.size()).toBe(2);
    handleMap.delete("handle_003");
    expect(handleMap.size()).toBe(1);
  });

  it("does NOT persist PAN, CVV, expiry, or holder_name (type-enforced by HandleMetadata)", () => {
    // TypeScript enforces this at compile time — we verify runtime behavior by confirming
    // the stored value only contains the documented fields.
    handleMap.set("handle_type_check", sampleMeta);
    const stored = handleMap.get("handle_type_check")!;

    // Only the documented fields should be present
    const storedKeys = Object.keys(stored);
    const allowedKeys: (keyof HandleMetadata)[] = [
      "spendRequestId",
      "last4",
      "targetMerchantName",
      "issuedAt",
      "validUntil",
    ];
    for (const key of storedKeys) {
      expect(allowedKeys).toContain(key);
    }

    // @ts-expect-error — pan is not a valid HandleMetadata key
    expect((stored as Record<string, unknown>)["pan"]).toBeUndefined();
    // @ts-expect-error — cvv is not a valid HandleMetadata key
    expect((stored as Record<string, unknown>)["cvv"]).toBeUndefined();
  });
});

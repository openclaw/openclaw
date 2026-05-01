import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendAuditRecord,
  expandStorePath,
  handleMap,
  initHandleStore,
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

  it("redacts CVV values inside arrays when parentKey is a CVV key (I2)", () => {
    const result = redactSensitiveValue({ cvv: ["123", "456"] }) as Record<string, unknown>;
    expect((result["cvv"] as unknown[])[0]).toBe("[REDACTED]");
    expect((result["cvv"] as unknown[])[1]).toBe("[REDACTED]");
  });

  it("does NOT redact non-CVV-key array values (I2 positive case)", () => {
    const result = redactSensitiveValue({ portNumbers: ["123"] }) as Record<string, unknown>;
    expect((result["portNumbers"] as unknown[])[0]).toBe("123");
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

describe("Authorization header redaction parity with redact-primitives", () => {
  it("redacts Proxy-Authorization: Payment header values", () => {
    const input = { headers: { "Proxy-Authorization": "Payment spt_test_xyz" } };
    const result = redactSensitiveValue(input);
    expect(JSON.stringify(result)).not.toContain("spt_test_xyz");
    expect(JSON.stringify(result)).toContain("[REDACTED]");
  });

  it("redacts case-variant Payment prefix (PAYMENT, payment)", () => {
    const input = { authorization: "PAYMENT spt_x" };
    const result = redactSensitiveValue(input);
    expect(JSON.stringify(result)).not.toContain("spt_x");
  });

  it("redacts Payment prefix with leading whitespace", () => {
    const input = { authorization: "  Payment spt_leading" };
    const result = redactSensitiveValue(input);
    expect(JSON.stringify(result)).not.toContain("spt_leading");
    expect(JSON.stringify(result)).toContain("[REDACTED]");
  });

  it("does NOT redact non-Payment auth (Bearer, Basic)", () => {
    const input = { authorization: "Bearer eyJhbGc..." };
    const result = redactSensitiveValue(input);
    expect(JSON.stringify(result)).toContain("Bearer eyJhbGc...");
  });

  it("does NOT redact Proxy-Authorization with Bearer scheme", () => {
    const input = { "Proxy-Authorization": "Bearer some-token" };
    const result = redactSensitiveValue(input);
    expect(JSON.stringify(result)).toContain("Bearer some-token");
  });

  it("does NOT redact Payment-only value (no token after)", () => {
    // "Payment" alone with no following non-whitespace token must not be redacted
    const input = { authorization: "Payment " };
    const result = redactSensitiveValue(input);
    expect(JSON.stringify(result)).not.toContain("[REDACTED]");
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

describe("redactSensitiveValue — circular reference guard (I1)", () => {
  it("handles a self-referential object without throwing and produces [Circular]", () => {
    const a: any = {};
    a.self = a;
    let result: unknown;
    expect(() => {
      result = redactSensitiveValue(a);
    }).not.toThrow();
    expect(JSON.stringify(result)).toContain("[Circular]");
  });

  it("still redacts a PAN even when the object also has a circular reference (I1)", () => {
    const a: any = { pan: "4242424242424242" };
    a.self = a;
    const result = redactSensitiveValue(a) as Record<string, unknown>;
    expect(result["pan"]).toBe("[REDACTED]");
    expect(result["self"]).toBe("[Circular]");
  });
});

describe("redactSensitiveValue — fail-closed on unexpected error (M3)", () => {
  it("returns [REDACTED] when a property getter throws", () => {
    const obj: Record<string, unknown> = {};
    Object.defineProperty(obj, "key", {
      get: () => {
        throw new Error("boom");
      },
      enumerable: true,
    });
    const result = redactSensitiveValue(obj);
    // The object-level redact catches the thrown error and returns "[REDACTED]"
    expect(result).toBe("[REDACTED]");
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

  it("concurrent appendAuditRecord calls produce all records without interleaving (I3)", async () => {
    const count = 20;
    const records = Array.from({ length: count }, (_, i) =>
      makeRecord({ openclawPaymentId: `pay_concurrent_${i}` }),
    );
    await Promise.all(records.map((r) => appendAuditRecord(storePath, r)));
    const written = await readAuditRecords(storePath);
    expect(written).toHaveLength(count);
    // Every id must be present and parseable (order doesn't matter)
    const ids = new Set(written.map((r) => r.openclawPaymentId));
    for (let i = 0; i < count; i++) {
      expect(ids.has(`pay_concurrent_${i}`)).toBe(true);
    }
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
    providerId: "mock",
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
      "providerId",
      "last4",
      "targetMerchantName",
      "issuedAt",
      "validUntil",
    ];
    for (const key of storedKeys) {
      expect(allowedKeys).toContain(key);
    }

    expect(stored.providerId).toBe("mock");
    // @ts-expect-error — pan is not a valid HandleMetadata key
    expect((stored as Record<string, unknown>)["pan"]).toBeUndefined();
    // @ts-expect-error — cvv is not a valid HandleMetadata key
    expect((stored as Record<string, unknown>)["cvv"]).toBeUndefined();
  });

  it("throws when a disallowed key is smuggled in (I8 — runtime privacy invariant)", () => {
    const smuggled = { spendRequestId: "x", issuedAt: "y", pan: "4242424242424242" } as any;
    expect(() => handleMap.set("h1", smuggled)).toThrowError(/pan/);
  });

  it("providerId is an allowed key in ALLOWED_HANDLE_METADATA_KEYS and round-trips correctly", () => {
    // providerId is a required field on HandleMetadata (TS-enforced); the runtime allow-list
    // must also accept it so handleMap.set does not throw.
    // Note: omitting providerId when constructing a HandleMetadata literal is a TypeScript error
    // caught at compile time — no runtime requirement is added for missing required keys.
    const metaWithProvider: HandleMetadata = {
      spendRequestId: "spend_req_provider_test",
      providerId: "mock",
      issuedAt: "2026-04-30T00:00:00.000Z",
    };
    expect(() => handleMap.set("handle_provider_test", metaWithProvider)).not.toThrow();
    expect(handleMap.get("handle_provider_test")?.providerId).toBe("mock");
  });
});

// ---------------------------------------------------------------------------
// initHandleStore — JSONL persistence / fresh-process recovery (Codex P2-5)
// ---------------------------------------------------------------------------

describe("initHandleStore — fresh-process recovery (Codex P2-5)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "payment-handle-store-test-"));
    // Clear the in-memory map before each test to simulate a fresh process
    for (const id of [...handleMap._map.keys()]) {
      handleMap.delete(id);
    }
  });

  afterEach(async () => {
    // Reset _handleStorePath by pointing to a fresh dir so subsequent tests
    // don't accidentally write to a stale path.
    await initHandleStore(await fs.mkdtemp(path.join(os.tmpdir(), "payment-handle-reset-")));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns 0 and leaves handleMap empty when handles.jsonl does not exist yet", async () => {
    const count = await initHandleStore(tmpDir);
    expect(count).toBe(0);
    expect(handleMap.size()).toBe(0);
  });

  it("loads persisted handles from handles.jsonl into memory (fresh-process simulation)", async () => {
    // Simulate a previous process: write a handles.jsonl manually
    const record = {
      handleId: "hndl_persisted_001",
      spendRequestId: "lsrq_test_persisted",
      providerId: "stripe-link",
      last4: "4242",
      issuedAt: "2026-04-30T00:00:00.000Z",
    };
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "handles.jsonl"), `${JSON.stringify(record)}\n`, "utf8");

    // Now simulate a fresh process calling initHandleStore
    const count = await initHandleStore(tmpDir);
    expect(count).toBe(1);
    const meta = handleMap.get("hndl_persisted_001");
    expect(meta).toBeDefined();
    expect(meta?.spendRequestId).toBe("lsrq_test_persisted");
    expect(meta?.providerId).toBe("stripe-link");
    expect(meta?.last4).toBe("4242");
  });

  it("loads multiple entries from handles.jsonl", async () => {
    const records = [
      {
        handleId: "hndl_multi_001",
        spendRequestId: "lsrq_multi_001",
        providerId: "stripe-link",
        issuedAt: "2026-04-30T00:00:00.000Z",
      },
      {
        handleId: "hndl_multi_002",
        spendRequestId: "lsrq_multi_002",
        providerId: "stripe-link",
        issuedAt: "2026-04-30T01:00:00.000Z",
      },
    ];
    const content = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "handles.jsonl"), content, "utf8");

    const count = await initHandleStore(tmpDir);
    expect(count).toBe(2);
    expect(handleMap.get("hndl_multi_001")?.spendRequestId).toBe("lsrq_multi_001");
    expect(handleMap.get("hndl_multi_002")?.spendRequestId).toBe("lsrq_multi_002");
  });

  it("skips records missing required fields (handleId, spendRequestId, providerId)", async () => {
    const lines = [
      // Missing handleId
      JSON.stringify({
        spendRequestId: "lsrq_no_handle",
        providerId: "mock",
        issuedAt: "2026-04-30T00:00:00.000Z",
      }),
      // Missing spendRequestId
      JSON.stringify({
        handleId: "hndl_no_spend",
        providerId: "mock",
        issuedAt: "2026-04-30T00:00:00.000Z",
      }),
      // Valid record
      JSON.stringify({
        handleId: "hndl_valid_only",
        spendRequestId: "lsrq_valid",
        providerId: "mock",
        issuedAt: "2026-04-30T00:00:00.000Z",
      }),
    ];
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "handles.jsonl"), lines.join("\n") + "\n", "utf8");

    const count = await initHandleStore(tmpDir);
    expect(count).toBe(1);
    expect(handleMap.get("hndl_valid_only")).toBeDefined();
  });

  it("skips records containing disallowed keys (tampered JSONL defense)", async () => {
    const tampered = {
      handleId: "hndl_tampered",
      spendRequestId: "lsrq_tampered",
      providerId: "mock",
      issuedAt: "2026-04-30T00:00:00.000Z",
      pan: "4242424242424242", // disallowed — must cause the entire record to be skipped
    };
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "handles.jsonl"), `${JSON.stringify(tampered)}\n`, "utf8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const count = await initHandleStore(tmpDir);
    warnSpy.mockRestore();

    expect(count).toBe(0);
    expect(handleMap.get("hndl_tampered")).toBeUndefined();
  });

  it("skips malformed (non-JSON) lines with a console.warn", async () => {
    const content = `not-json\n${JSON.stringify({ handleId: "hndl_good", spendRequestId: "lsrq_good", providerId: "mock", issuedAt: "2026-04-30T00:00:00.000Z" })}\n`;
    await fs.mkdir(tmpDir, { recursive: true });
    await fs.writeFile(path.join(tmpDir, "handles.jsonl"), content, "utf8");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const count = await initHandleStore(tmpDir);
    expect(count).toBe(1);
    expect(warnSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });

  it("handleMap.set() fire-and-forgets persistence to handles.jsonl", async () => {
    await initHandleStore(tmpDir);

    const meta: HandleMetadata = {
      spendRequestId: "lsrq_persist_test",
      providerId: "stripe-link",
      last4: "9999",
      issuedAt: "2026-04-30T00:00:00.000Z",
    };
    handleMap.set("hndl_persist_test", meta);

    // Drain microtask/macrotask queue to let the fire-and-forget write complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify handles.jsonl now contains the persisted record
    const raw = await fs.readFile(path.join(tmpDir, "handles.jsonl"), "utf8");
    const parsed = JSON.parse(raw.trim()) as Record<string, unknown>;
    expect(parsed["handleId"]).toBe("hndl_persist_test");
    expect(parsed["spendRequestId"]).toBe("lsrq_persist_test");
    expect(parsed["last4"]).toBe("9999");

    // Verify no sensitive data leaked into the file
    expect(raw).not.toContain("4242");
  });

  it("fresh initHandleStore after a set() recovers the written handle", async () => {
    await initHandleStore(tmpDir);

    const meta: HandleMetadata = {
      spendRequestId: "lsrq_round_trip",
      providerId: "stripe-link",
      issuedAt: "2026-04-30T00:00:00.000Z",
    };
    handleMap.set("hndl_round_trip", meta);

    // Wait for fire-and-forget write
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Simulate fresh process: clear memory and re-init
    for (const id of [...handleMap._map.keys()]) {
      handleMap.delete(id);
    }
    expect(handleMap.get("hndl_round_trip")).toBeUndefined();

    const count = await initHandleStore(tmpDir);
    expect(count).toBe(1);
    expect(handleMap.get("hndl_round_trip")?.spendRequestId).toBe("lsrq_round_trip");
  });
});

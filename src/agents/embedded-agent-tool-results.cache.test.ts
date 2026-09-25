import { afterEach, expect, it, vi } from "vitest";
import * as loggingConfigModule from "../logging/config.js";
import * as redaction from "../logging/redact.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { sanitizeToolResult } from "./embedded-agent-tool-results.js";

afterEach(() => {
  vi.restoreAllMocks();
  resetSecretRedactionRegistryForTest();
});

it("reuses sanitized arrays and objects without reprocessing their text or images", () => {
  const deepRedact = vi.spyOn(redaction, "redactModelVisibleSecrets");
  for (const input of [
    { content: [{ type: "image", data: "aGVsbG8=" }], details: { token: "fixture-secret" } },
    [{ token: "fixture-secret" }],
  ]) {
    const sanitized = sanitizeToolResult(input);
    expect(JSON.stringify(sanitized)).not.toContain("fixture-secret");
    expect(sanitizeToolResult(input)).toEqual(sanitized);
    expect(sanitizeToolResult(sanitized)).toEqual(sanitized);
  }
  expect(deepRedact).toHaveBeenCalledTimes(2);
});

it.each(["input", "output"] as const)(
  "redacts nested %s mutations and appended blocks",
  (target) => {
    const input = {
      content: [{ type: "text", text: "ordinary" }],
      details: { token: "first-secret" },
    };
    const sanitized = sanitizeToolResult(input) as typeof input;
    const changed = target === "input" ? input : sanitized;
    changed.details.token = "second-secret";
    changed.content.push({ type: "text", text: "Authorization: Bearer appended-secret-value" });
    const next = sanitizeToolResult(changed);
    expect(JSON.stringify(next)).not.toContain("second-secret");
    expect(JSON.stringify(next)).not.toContain("appended-secret-value");
    expect(next).toMatchObject({ content: [{ text: "ordinary" }, { type: "text" }] });
  },
);

it("does not return a cached output modified by an earlier consumer", () => {
  const input = { details: { note: "ordinary" } };
  const sanitized = sanitizeToolResult(input) as typeof input;
  sanitized.details.note = "Authorization: Bearer consumer-secret-value";
  expect(sanitizeToolResult(input)).toEqual({ details: { note: "ordinary" } });
});

it.each(["add", "delete", "enumerability", "prototype", "array-length"] as const)(
  "rechecks structural changes (%s)",
  (change) => {
    const input = { details: { note: "ordinary" }, content: [{ type: "text", text: "kept" }] };
    const deepRedact = vi.spyOn(redaction, "redactModelVisibleSecrets");
    sanitizeToolResult(input);
    if (change === "add") {
      Object.assign(input.details, { token: "added-secret" });
    } else if (change === "delete") {
      Reflect.deleteProperty(input.details, "note");
    } else if (change === "enumerability") {
      Object.defineProperty(input.details, "note", { enumerable: false });
    } else if (change === "prototype") {
      Object.setPrototypeOf(input.details, null);
    } else {
      input.content.length = 0;
    }
    const next = sanitizeToolResult(input);
    expect(deepRedact).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(next)).not.toContain("added-secret");
    if (change === "array-length") {
      expect(next).toMatchObject({ content: [] });
    }
  },
);

it("invalidates both original and prepared results for changed patterns and registered secrets", () => {
  const patterns = ["unrelated-value"];
  vi.spyOn(loggingConfigModule, "readLoggingConfig").mockReturnValue({ redactPatterns: patterns });
  const input = { details: { note: "opaque(abcdefghijklmnopqrst) extra(01234567890123456789)" } };
  const prepared = sanitizeToolResult(input);
  expect(prepared).toEqual(input);
  patterns.push(String.raw`/opaque\(([^)]+)\)/g`);
  for (const candidate of [input, prepared]) {
    expect(JSON.stringify(sanitizeToolResult(candidate))).not.toContain("abcdefghijklmnopqrst");
  }
  registerSecretValueForRedaction("01234567890123456789");
  for (const candidate of [input, prepared]) {
    expect(JSON.stringify(sanitizeToolResult(candidate))).not.toContain("01234567890123456789");
  }
});

it("does not memoize getters or proxies whose reads can change during sanitization", () => {
  let value = "first-secret";
  const getter = {
    get token() {
      return value;
    },
  };
  const proxy = new Proxy(
    {},
    {
      ownKeys: () => ["token"],
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
      get: () => value,
    },
  );
  for (const input of [getter, proxy]) {
    sanitizeToolResult(input);
    value = "second-secret";
    const deepRedact = vi.spyOn(redaction, "redactModelVisibleSecrets");
    expect(sanitizeToolResult(input)).toEqual({ token: "***" });
    expect(deepRedact).toHaveBeenCalled();
    deepRedact.mockRestore();
  }
});

it("rechecks an accessor installed on a previously cached data property", () => {
  const input = { details: { token: "first-secret" } };
  sanitizeToolResult(input);
  Object.defineProperty(input.details, "token", { enumerable: true, get: () => "second-secret" });
  expect(sanitizeToolResult(input)).toEqual({ details: { token: "***" } });
});

it("preserves cycles and shared references without retaining stale nested values", () => {
  const shared = { token: "first-secret" };
  const input: Record<string, unknown> = { first: shared, second: shared };
  input.self = input;
  const first = sanitizeToolResult(input);
  expect(sanitizeToolResult(input)).toEqual(first);
  shared.token = "second-secret";
  expect(JSON.stringify(sanitizeToolResult(input))).not.toContain("second-secret");
});

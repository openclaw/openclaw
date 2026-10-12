import { afterEach, expect, it, vi } from "vitest";
import * as loggingConfigModule from "../logging/config.js";
import * as redaction from "../logging/redact.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { prepareToolResult, sanitizeToolResult } from "./embedded-agent-tool-results.js";

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
    const readResult = prepareToolResult(input);
    const sanitized = readResult();
    expect(JSON.stringify(sanitized)).not.toContain("fixture-secret");
    expect(readResult()).toBe(sanitized);
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
  const readResult = prepareToolResult(input);
  const sanitized = readResult() as typeof input;
  sanitized.details.note = "Authorization: Bearer consumer-secret-value";
  expect(readResult()).toEqual({ details: { note: "ordinary" } });
});

it.each(["add", "enumerability", "prototype", "array-length"] as const)(
  "rechecks structural changes (%s)",
  (change) => {
    const input = { details: { note: "ordinary" }, content: [{ type: "text", text: "kept" }] };
    const deepRedact = vi.spyOn(redaction, "redactModelVisibleSecrets");
    const readResult = prepareToolResult(input);
    readResult();
    if (change === "add") {
      Object.assign(input.details, { token: "added-secret" });
    } else if (change === "enumerability") {
      Object.defineProperty(input.details, "note", { enumerable: false });
    } else if (change === "prototype") {
      Object.setPrototypeOf(input.details, null);
    } else {
      input.content.length = 0;
    }
    const next = readResult();
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
  const readResult = prepareToolResult(input);
  const prepared = readResult();
  const readPrepared = prepareToolResult(prepared);
  expect(readPrepared()).toEqual(input);
  patterns.push(String.raw`/opaque\(([^)]+)\)/g`);
  for (const read of [readResult, readPrepared]) {
    expect(JSON.stringify(read())).not.toContain("abcdefghijklmnopqrst");
  }
  registerSecretValueForRedaction("01234567890123456789");
  for (const read of [readResult, readPrepared]) {
    expect(JSON.stringify(read())).not.toContain("01234567890123456789");
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
    const readResult = prepareToolResult(input);
    readResult();
    value = "second-secret";
    const deepRedact = vi.spyOn(redaction, "redactModelVisibleSecrets");
    expect(readResult()).toEqual({ token: "***" });
    expect(deepRedact).toHaveBeenCalled();
    deepRedact.mockRestore();
  }
});

it("rechecks an accessor installed on a previously cached data property", () => {
  const input = { details: { token: "first-secret" } };
  const readResult = prepareToolResult(input);
  readResult();
  Object.defineProperty(input.details, "token", { enumerable: true, get: () => "second-secret" });
  expect(readResult()).toEqual({ details: { token: "***" } });
});

it("preserves cycles and shared references without retaining stale nested values", () => {
  const shared = { token: "first-secret" };
  const input: Record<string, unknown> = { first: shared, second: shared };
  input.self = input;
  const readResult = prepareToolResult(input);
  const first = readResult();
  expect(readResult()).toEqual(first);
  shared.token = "second-secret";
  expect(JSON.stringify(readResult())).not.toContain("second-secret");
});

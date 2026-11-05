import { describe, expect, it, vi } from "vitest";
import {
  boundCodeModeError,
  captureCodeModeOutput,
  captureCodeModeValue,
  CodeModeOutputState,
  toCodeModeJsonSafe,
} from "./code-mode-json.js";
import { estimateToolResultTextChars } from "./embedded-agent-runner/tool-result-text-budget.js";
import { toolResultFitsBudget } from "./tool-result-limits.js";
import { serializeToolSearchControlResult } from "./tool-search-control-result.js";

function reference(bytes: number, preview: string, id = "result_synthetic") {
  return { id, bytes, count: 1, shape: "object", preview, previewTruncated: true };
}

describe("Code Mode JSON normalization", () => {
  it.each(["output", "error"])("bounds serialization work for oversized %s", (channel) => {
    const text = "x".repeat(64_000);
    const state = new CodeModeOutputState(65_536, {
      maxChars: 16_000,
      maxContextChars: 32_000,
    });
    if (channel === "output") {
      state.append(captureCodeModeOutput([{ type: "text", text }], 65_536));
    }
    const stringify = JSON.stringify;
    const parse = JSON.parse;
    let serializedChars = 0;
    let parsedChars = 0;
    let serializations = 0;
    const stringSpy = vi.spyOn(globalThis, "String");
    const spy = vi.spyOn(JSON, "stringify").mockImplementation((...args) => {
      serializations++;
      const json = stringify(...args);
      serializedChars += json?.length ?? 0;
      return json;
    });
    const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((...args) => {
      parsedChars += args[0].length;
      return parse(...args);
    });
    let result;
    let stringConversions: number;
    try {
      result = state.takeResult(
        { status: channel === "error" ? "failed" : "completed" },
        channel === "error" ? { error: text } : {},
      );
    } finally {
      stringConversions = stringSpy.mock.calls.length;
      stringSpy.mockRestore();
      spy.mockRestore();
      parseSpy.mockRestore();
    }
    expect(JSON.stringify(result)).toHaveLength(16_000);
    // Trials measure captured JSON and changed prefix intervals, not whole envelopes.
    expect(serializedChars).toBeLessThan(210_000);
    expect(serializations).toBeLessThanOrEqual(5);
    // Rejected complete channels must not be decoded before selecting their bounded prefix.
    expect(parsedChars).toBeLessThan(16_000);
    // Decimal marker widths must not allocate one string per prefix byte.
    expect(stringConversions).toBeLessThan(100);
  });

  it.each([
    [false, false, false, false],
    [false, false, false, true],
    [true, false, false, false],
    [false, true, false, false],
    [false, false, true, false],
    [true, true, true, false],
    [true, true, true, true],
  ])("matches serialized budgets for channel combination %#", (output, value, error, retained) => {
    for (const repeat of [1, 1_024]) {
      const text = 'a"\\\n\r\b\f\t\0é中🌍\ud800z\udfff·꜀ˇ𝍠𠀀\u2028'.repeat(repeat);
      const maxBytes = 8_192;
      const state = new CodeModeOutputState(maxBytes);
      if (output) {
        state.append(captureCodeModeOutput([{ text }, text], maxBytes));
      }
      const params = {
        ...(value ? { value: captureCodeModeValue({ text }, maxBytes) } : {}),
        ...(error ? { error: text } : {}),
        valueGuidance: "Return less data.",
        ...(retained ? { reference: reference(Buffer.byteLength(text), text.slice(0, 128)) } : {}),
      };
      const metadata = {
        status: "completed",
        [text.slice(0, 8)]: { detail: text.slice(0, 128) },
        output: "overwritten",
        value: "metadata value",
        error: "metadata error",
      };
      // Exercise the production projector directly, without a test-only budget API.
      const project = state["createProjector"](params, metadata);
      // Descending and ascending probes cover reuse of measured prefix intervals.
      for (const limit of [maxBytes, 0, 1, maxBytes - 1, 128, 4_096, 512]) {
        const measured = project(limit, "budget");
        const json = serializeToolSearchControlResult(
          { ...metadata, ...project(limit).channels },
          true,
        );
        expect(measured, `repeat=${repeat}, limit=${limit}`).toEqual({
          chars: estimateToolResultTextChars(json),
          contextChars: estimateToolResultTextChars(json, { minimumRawWeight: 2 }),
        });
      }
    }
  });

  it("rejects a model budget that cannot fit the status envelope", () => {
    const state = new CodeModeOutputState(128, { maxChars: 0, maxContextChars: 0 });
    expect(() => state.takeResult({ status: "completed" })).toThrow(
      "Model tool-result budget cannot fit Code Mode status",
    );
  });

  it("projects owned channels over metadata without losing unrelated fields", () => {
    const state = new CodeModeOutputState(1_024);
    state.append(captureCodeModeOutput(["output"], 1_024));
    expect(
      state.takeResult(
        {
          status: "completed",
          telemetry: { calls: 1 },
          output: "stale",
          value: "stale",
          error: "stale",
        },
        { value: captureCodeModeValue("value", 1_024), error: "diagnostic" },
      ),
    ).toEqual({
      status: "completed",
      telemetry: { calls: 1 },
      output: ["output"],
      value: "value",
      error: "diagnostic",
    });
  });

  it.each(["capacity", "undeliverable reference"])(
    "preserves successful output when %s guidance exceeds the model budget",
    (failure) => {
      const value = captureCodeModeValue({ text: "data".repeat(1_000) }, 4_096);
      const budget = { maxChars: 160, maxContextChars: 2_048 };
      const metadata = { status: "completed" };
      const original = new CodeModeOutputState(1_024, budget).takeResult(metadata, { value });
      expect(original).toMatchObject({ status: "completed", value: { truncated: true } });
      const release = vi.fn();
      const output = new CodeModeOutputState(1_024, budget).takeResult(
        metadata,
        { value },
        false,
        () =>
          failure === "capacity"
            ? {
                reason:
                  "Not retained: result-store capacity exceeded. Delete references or return less data.",
              }
            : {
                reference: reference(
                  4_011,
                  "sample",
                  "result_00000000-0000-0000-0000-000000000000",
                ),
                release,
              },
      );
      expect(output).toMatchObject({
        status: "completed",
        value: { truncated: true, guidance: expect.stringContaining("Not retained") },
      });
      expect(output.value).not.toHaveProperty("reference");
      expect(toolResultFitsBudget(JSON.stringify(output), budget)).toBe(true);
      expect(release).toHaveBeenCalledTimes(failure === "capacity" ? 0 : 1);
    },
  );

  it.each([
    { limit: 20, prefix: "" },
    { limit: 24, prefix: 'a"' },
    { limit: 35, prefix: 'a"\\\n\r\t\b\f' },
    { limit: 50, prefix: 'a"\\\n\r\t\b\f\u0000\u0001é' },
    { limit: 72, prefix: 'a"\\\n\r\t\b\f\u0000\u0001é中🌍�za"\\\n\r\t' },
  ])("fits escaped diagnostics at $limit bytes", ({ limit, prefix }) => {
    const error = 'a"\\\n\r\t\b\f\u0000\u0001é中🌍\ud800z'.repeat(8);
    expect(boundCodeModeError(error, limit)).toBe(`${prefix} [error truncated]`);
  });

  it("preserves whole lone surrogates and decodes only partial diagnostics", () => {
    expect(boundCodeModeError("\ud800x", 20)).toBe("\ud800x");
    expect(boundCodeModeError("\ud800".repeat(6), 30)).toBe("��� [error truncated]");
  });

  it.each([
    { limit: 107, prefix: "", omittedBytes: 1000 },
    { limit: 108, prefix: '"', omittedBytes: 999 },
    { limit: 109, prefix: '"a', omittedBytes: 998 },
  ])("fits marker digit-width transitions at $limit bytes", ({ limit, prefix, omittedBytes }) => {
    expect(
      new CodeModeOutputState(limit).take({ value: captureCodeModeValue("a".repeat(998), limit) })
        .value,
    ).toEqual({
      truncated: true,
      omittedBytes,
      guidance: "Output truncated; rerun with narrower args.",
      prefix,
    });
  });

  it.each([
    { name: "undefined", value: undefined, expected: null },
    { name: "null", value: null, expected: null },
    { name: "true", value: true, expected: true },
    { name: "false", value: false, expected: false },
    { name: "empty text", value: "", expected: "" },
    { name: "Unicode and escapes", value: '\ud800"\\\n🌍漢字', expected: '\ud800"\\\n🌍漢字' },
    { name: "negative zero", value: -0, expected: 0 },
    { name: "NaN", value: Number.NaN, expected: null },
    { name: "infinity", value: Infinity, expected: null },
    { name: "bigint", value: 12n, expected: "12" },
    { name: "symbol", value: Symbol("synthetic"), expected: null },
    { name: "ordinary Error", value: new Error("synthetic"), expected: {} },
  ])("preserves $name through normalization and capture", ({ value, expected }) => {
    expect(toCodeModeJsonSafe(value)).toEqual(expected);
    expect(captureCodeModeValue(value, 1_024)).toEqual({
      kind: "complete",
      json: JSON.stringify(expected),
    });
  });

  it("keeps captured and delivered structured values detached from later mutation", async () => {
    const input = { nested: { label: "before" }, items: ["before"] };
    const normalized = toCodeModeJsonSafe(input);
    const captured = captureCodeModeValue(input, 1_024);
    input.nested.label = "after";
    input.items.push("after");
    expect(normalized).toEqual({ nested: { label: "before" }, items: ["before"] });
    expect(captured).toEqual({
      kind: "complete",
      json: '{"nested":{"label":"before"},"items":["before"]}',
    });

    const state = new CodeModeOutputState(65_536, { maxChars: 2_048, maxContextChars: 4_096 });
    state.append(captureCodeModeOutput([{ type: "text", text: "x".repeat(10_000) }], 65_536));
    const first = state.takeResult({ status: "completed" }, { value: captured });
    expect(first.value).toEqual(normalized);
    expect(first.output).toEqual([expect.objectContaining({ truncated: true })]);
    if (!first.value || typeof first.value !== "object") {
      throw new Error("Expected a structured delivered value");
    }
    Object.assign(first.value, { nested: { label: "changed after delivery" } });
    await Promise.resolve();

    const second = state.takeResult({ status: "completed" }, { value: captured });
    expect(second).toMatchObject({ value: normalized, output: [] });
  });

  it("retains cycle fallbacks and normalizes each output entry with the root toJSON key", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const error = Object.assign(new Error("synthetic"), { cyclic });
    expect(toCodeModeJsonSafe(cyclic)).toBe("[object Object]");
    expect(toCodeModeJsonSafe(error)).toEqual({ name: "Error", message: "synthetic" });
    const keys: string[] = [];
    const output: unknown[] = [];
    output[2] = {
      toJSON(key: string) {
        keys.push(key);
        return { value: "kept" };
      },
    };
    expect(captureCodeModeOutput(output, 1_024)).toEqual({
      count: 3,
      source: { kind: "complete", json: '[null,null,{"value":"kept"}]' },
    });
    expect(keys).toEqual([""]);
    expect(Object.hasOwn(output, 0)).toBe(false);
  });
});

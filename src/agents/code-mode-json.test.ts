import { createHash } from "node:crypto";
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
    let serializedChars = 0;
    let serializations = 0;
    const spy = vi.spyOn(JSON, "stringify").mockImplementation((...args) => {
      serializations++;
      const json = stringify(...args);
      serializedChars += json?.length ?? 0;
      return json;
    });
    let result;
    try {
      result = state.takeResult(
        { status: channel === "error" ? "failed" : "completed" },
        channel === "error" ? { error: text } : {},
      );
    } finally {
      spy.mockRestore();
    }
    expect(JSON.stringify(result)).toHaveLength(16_000);
    // Trials measure captured JSON and changed prefix intervals, not whole envelopes.
    expect(serializedChars).toBeLessThan(210_000);
    expect(serializations).toBeLessThanOrEqual(5);
  });

  it("matches fully serialized budgets for every randomized projection probe", () => {
    let seed = 0x77c0de;
    const next = (bound: number) => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) % bound;
    };
    const alphabet = [
      "a",
      '"',
      "\\",
      "\n",
      "\r",
      "\b",
      "\f",
      "\t",
      "\0",
      "é",
      "中",
      "🌍",
      "\ud800",
      "\udfff",
      "·",
      "꜀",
      "ˇ",
      "𝍠",
      "𠀀",
      "\u2028",
    ];
    for (let fixture = 0; fixture < 64; fixture++) {
      const text = Array.from({ length: 1 + next(128) }, () => alphabet[next(alphabet.length)]!)
        .join("")
        .repeat(1 + next(32));
      const maxBytes = 128 + next(8_192);
      const state = new CodeModeOutputState(maxBytes);
      if (fixture % 3) {
        state.append(captureCodeModeOutput([{ text }, text], maxBytes));
      }
      const params = {
        ...(fixture % 4 ? { value: captureCodeModeValue({ text }, maxBytes) } : {}),
        ...(fixture % 5 ? { error: text } : {}),
        valueGuidance: text.slice(0, next(64)),
        ...(fixture % 7 === 0
          ? {
              reference: {
                id: "result_synthetic",
                bytes: Buffer.byteLength(text),
                count: 1,
                shape: "object",
                preview: text.slice(0, next(128)),
                previewTruncated: true,
              },
            }
          : {}),
      };
      const metadata = {
        status: "completed",
        [text.slice(0, 8)]: { detail: text.slice(0, next(128)) },
        output: "overwritten",
        value: "metadata value",
        error: "metadata error",
      };
      // Exercise the production projector directly, without a test-only budget API.
      const project = state["createProjector"](params, metadata);
      const assertProbe = (limit: number) => {
        const measured = project(limit, "budget");
        const json = serializeToolSearchControlResult(
          { ...metadata, ...project(limit).channels },
          true,
        );
        expect(measured, `fixture=${fixture}, limit=${limit}`).toEqual({
          chars: estimateToolResultTextChars(json),
          contextChars: estimateToolResultTextChars(json, { minimumRawWeight: 2 }),
        });
        return measured;
      };
      // Arbitrary order exercises both directions of the retained interval measurement.
      for (const limit of [
        maxBytes,
        0,
        1,
        maxBytes - 1,
        ...Array.from({ length: 20 }, () => next(maxBytes + 1)),
      ]) {
        assertProbe(limit);
      }
      const budget = { maxChars: 128 + next(maxBytes), maxContextChars: 256 + next(maxBytes * 2) };
      let low = 0;
      let high = maxBytes;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const measured = assertProbe(middle);
        if (measured.chars <= budget.maxChars && measured.contextChars <= budget.maxContextChars) {
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
    }
  });

  it.each([
    { text: "ascii", digest: "cc82812183d5ed7fef2f0962654a749276f13cc88eaf3e9542e8034b56d81543" },
    {
      text: 'a"\\\n\r\t\b\f\u0000',
      digest: "d63c1219facc698ecfb3bc03aba3a7c2bc9e6cc16ebfab4bc4fb809a606bd936",
    },
    {
      text: "\u00e9\u4e2d\ud83c\udf0d\ud800z",
      digest: "195c485e5cf655cb43afac31ff426d49ad11691c1abf0be57fd657fd993b8e9e",
    },
    {
      text: "\u00b7\ua700\u02c7\ud834\udf60\ud840\udc00",
      digest: "0e867347ed3060cc6f69f9e91fb748407db258978bc1d3b4884ba01d52c0d835",
    },
    {
      text: '<<<EXTERNAL_UNTRUSTED_CONTENT id="x">>>[im_start]',
      digest: "c9aa01b87a279d74760780266285ef429a84d9e2961a9886439048eace94de27",
    },
  ])("preserves baseline JSON bytes for $text", ({ text, digest }) => {
    const hash = createHash("sha256");
    for (const repeat of [0, 1, 37, 1_024]) {
      for (const [maxBytes, maxChars, maxContextChars, network] of [
        [128, 160, 320, false],
        [1_024, 256, 300, false],
        [65_536, 16_000, 32_000, false],
        [1_024, 1_200, 2_400, true],
      ] as const) {
        const state = new CodeModeOutputState(maxBytes, { maxChars, maxContextChars });
        const input = text.repeat(repeat);
        state.append(captureCodeModeOutput([{ text: input }], maxBytes));
        const value = captureCodeModeValue({ input }, maxBytes);
        let released = 0;
        try {
          for (const valueGuidance of [undefined, "Not retained; return less data."]) {
            const result = state.takeResult(
              {
                status: "completed",
                telemetry: { calls: 1 },
                value: "overwritten",
                error: "metadata error",
              },
              { value, ...(repeat % 2 ? { error: input } : {}), valueGuidance },
              network,
              repeat === 37
                ? () => ({
                    reference: {
                      id: "result_synthetic",
                      bytes: input.length,
                      count: 1,
                      shape: "object",
                      preview: input.slice(0, 80),
                      previewTruncated: true,
                    },
                    release() {
                      released++;
                    },
                  })
                : undefined,
            );
            hash.update(JSON.stringify(result));
          }
        } catch (error) {
          if (!(error instanceof Error)) {
            throw error;
          }
          hash.update(error.message);
        }
        hash.update(String(released));
      }
    }
    expect(hash.digest("hex")).toBe(digest);
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
                reference: {
                  id: "result_00000000-0000-0000-0000-000000000000",
                  bytes: 4_011,
                  count: 1,
                  shape: "object",
                  preview: "sample",
                  previewTruncated: true,
                },
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
    state.append(captureCodeModeOutput([{ type: "text", text: "next" }], 65_536));
    expect(
      state.takeResult({ status: "completed" }, { value: captureCodeModeValue(null, 65_536) })
        .value,
    ).toBeNull();
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

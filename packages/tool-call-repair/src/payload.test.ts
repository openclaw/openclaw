import { describe, expect, it, vi } from "vitest";
import {
  projectPlainTextToolCallBlocks,
  scanPlainTextToolCall,
  stripPlainTextToolCallBlocks,
} from "./payload.js";

function trackStringOperations(value: string) {
  const counts = { indexedReads: 0, indexOfCalls: 0 };
  const text = new Proxy(Object(value) as object, {
    get(target, property) {
      if (typeof property === "string" && /^(?:0|[1-9]\d*)$/.test(property)) {
        counts.indexedReads += 1;
      }
      if (property === "indexOf") {
        return (searchString: string, position?: number) => {
          counts.indexOfCalls += 1;
          return value.indexOf(searchString, position);
        };
      }
      const member = Reflect.get(target, property, target) as unknown;
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return { counts, text: text as unknown as string };
}

function expectStripped(
  raw: string,
  expected = raw,
  options?: Parameters<typeof stripPlainTextToolCallBlocks>[1],
) {
  expect(stripPlainTextToolCallBlocks(raw, options)).toBe(expected);
}

function projection(raw: string, settleBefore?: number) {
  const { text, retainStart, retainedOutputStart } = projectPlainTextToolCallBlocks(raw, {
    settleBefore,
  });
  return [text, retainStart, retainedOutputStart];
}

describe("scanPlainTextToolCall JSON branch", () => {
  it("classifies a partial Harmony header and strips the completed call", () => {
    expect(scanPlainTextToolCall("commentary to=read co").json.kind).toBe("prefix");
    expectStripped("<|channel|>commentary to=read code<|message|>{}<|call|>visible", "visible");
  });

  it.each([
    [1, (name: string) => `[${name}]\n{}[/${name}]`],
    [6, (name: string) => `[tool:${name}] {}`],
    [12, (name: string) => `analysis to=${name} code {}`],
  ] as const)(
    "accepts 120-character names and rejects the 121st character at offset %s",
    (nameStart, build) => {
      const prefix = "Visible\n";
      const scan = (length: number) =>
        scanPlainTextToolCall(prefix + build("x".repeat(length)), prefix.length).json;
      expect(scan(120).kind).toBe("complete");
      expect(scan(121)).toEqual({ kind: "invalid", at: prefix.length + nameStart + 120 });
    },
  );
});

describe("stripPlainTextToolCallBlocks", () => {
  it("does not resolve Markdown ownership without a bracket payload", () => {
    const raw = "[guide](https://example.test)\nUse `code`.\n[tool:read]\n";
    const resolveProtectedRanges = vi.fn(() => []);
    for (let end = 1; end <= raw.length; end++) {
      expectStripped(raw.slice(0, end), undefined, { resolveProtectedRanges });
    }
    expect(resolveProtectedRanges).not.toHaveBeenCalled();
  });

  it.each(['Example [tool:read]{"path":"example.txt"}', '[read]\n{"path":}\n[/read]'])(
    "preserves non-call text: %s",
    (raw) => expectStripped(raw),
  );

  it.each(["\r", "\r\n"])("strips Unicode-indented bracket calls after %j", (lineBreak) => {
    const prefix = `Before${lineBreak}`;
    const strip = (call: string) =>
      expectStripped(`${prefix}${call}${lineBreak}After`, `${prefix}After`);
    strip(`\u00a0\t[read]${lineBreak}{}[/read]`);
    strip("\u2003[tool:read]<parameter=x>x</parameter> [tool:write]{}");
  });

  it("preserves protected candidates while stripping adjacent unprotected calls", () => {
    const protectedCall = "[read]\n{}\n[/read]";
    const raw = `${protectedCall}\n${protectedCall}`;
    expectStripped(raw, `${protectedCall}\n`, {
      resolveProtectedRanges: () => [{ start: 0, end: protectedCall.length }],
    });
    expectStripped(raw, "");
  });

  it("preserves a long repeated incomplete JSON candidate in one scan", () => {
    const raw = "[tool:read] {\n".repeat(20_000);
    expect(scanPlainTextToolCall(raw).json).toMatchObject({
      kind: "prefix",
      candidate: { payload: { end: raw.length } },
    });
    expectStripped(raw);
  });

  const invalidXml = "<function=read><parameter=x>x\n".repeat(256) + "</parameter>X";
  const invalidJson = "[read]\n{\n".repeat(256) + "}".repeat(256) + "[/wrong]";
  const protectedExample = "```text\n" + "[tool:read] {\n".repeat(128) + "```";
  it.each([
    [invalidXml, "indexOfCalls", 256 * 8, false],
    [invalidJson, "indexedReads", invalidJson.length * 16, false],
    [protectedExample, "indexedReads", protectedExample.length * 16, true],
  ] as const)("bounds scanning while preserving %j", (raw, counter, limit, protect) => {
    const tracked = trackStringOperations(raw);
    expectStripped(tracked.text, raw, {
      resolveProtectedRanges: protect ? () => [{ start: 0, end: raw.length }] : undefined,
    });
    expect(tracked.counts[counter]).toBeGreaterThan(0);
    expect(tracked.counts[counter]).toBeLessThan(limit);
  });
});

describe("projectPlainTextToolCallBlocks", () => {
  const prefix = "Before\n";
  const settled = "[read]\n{}[/read]\n";
  const offset = prefix.length;
  it.each([
    [prefix + "[read]\n\n", prefix + "[read]\n\n", offset, offset],
    [prefix + "[tool:read] {}\n", prefix, offset, offset],
    [prefix + "[tool:read] {}\n[", prefix + "[tool:read] {}\n[", offset, offset],
    [prefix + "[tool:read]<parameter=x>value</parameter>\n", prefix, offset, offset],
    [prefix + "[read]\n{}[/read] [write]\n", prefix + " [write]\n", offset, offset],
    [prefix + settled + "Tail", prefix + "Tail", offset + settled.length, offset],
    [prefix + settled + "Tail", prefix + "Tail", offset, offset, offset],
    [settled.replace(/\n$/, "\r"), "", 0, 0],
    [settled.replace(/\n$/, "\r\n"), "", settled.length + 1, 0],
  ] as const)(
    "projects text and retained boundaries for %j",
    (raw, visible, retained, output, limit) => {
      expect(projection(raw, limit)).toEqual([visible, retained, output]);
    },
  );
});

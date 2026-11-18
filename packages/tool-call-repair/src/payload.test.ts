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

describe("scanPlainTextToolCall", () => {
  it.each<[number, boolean]>([
    [256_000, false],
    [256_001, true],
  ])("excludes XML closers from the cap for %i payload bytes", (bytes, overCap) => {
    const prefix = `<function=read>${" ".repeat(bytes)}</func`;
    expect(scanPlainTextToolCall(prefix)).toMatchObject({ kind: "prefix", overCap });
    expect(scanPlainTextToolCall(`${prefix}tion>`)).toMatchObject({ kind: "complete", overCap });
  });

  it("returns the complete Harmony call before a visible suffix", () => {
    const raw = '<|channel|>commentary to=read code<|message|>{"path":"/tmp/file"}<|call|>visible';
    expect(scanPlainTextToolCall(raw).json).toMatchObject({
      kind: "complete",
      end: raw.indexOf("visible"),
      name: { start: raw.indexOf("read"), end: raw.indexOf("read") + 4 },
      payload: { start: raw.indexOf("{"), end: raw.indexOf("}") + 1 },
    });
  });

  it("classifies the streaming Harmony prefix", () => {
    expect(scanPlainTextToolCall("commentary to=read co").json).toMatchObject({
      kind: "prefix",
      candidate: { syntax: "harmony", nameComplete: true, name: { start: 14, end: 18 } },
    });
  });

  it.each([
    [1, (name: string) => `[${name}]\n{}[/${name}]`],
    [6, (name: string) => `[tool:${name}] {}`],
    [12, (name: string) => `analysis to=${name} code {}`],
  ] as const)(
    "accepts 120-character names and rejects the 121st character at offset %s",
    (nameStart, build) => {
      const prefix = "Visible\n";
      expect(scanPlainTextToolCall(prefix + build("x".repeat(120)), prefix.length).json.kind).toBe(
        "complete",
      );
      for (const length of [121, 1024]) {
        expect(
          scanPlainTextToolCall(prefix + build("x".repeat(length)), prefix.length).json,
        ).toEqual({
          kind: "invalid",
          at: prefix.length + nameStart + 120,
        });
      }
    },
  );
});

describe("stripPlainTextToolCallBlocks", () => {
  it("does not scan payloads inside protected code examples", () => {
    const raw = "```text\n" + "[tool:read] {\n".repeat(128) + "```";
    const tracked = trackStringOperations(raw);
    expectStripped(tracked.text, raw, {
      resolveProtectedRanges: () => [{ start: 0, end: raw.length }],
    });
    expect(tracked.counts.indexedReads).toBeGreaterThan(0);
    expect(tracked.counts.indexedReads).toBeLessThan(raw.length * 16);
  });

  it.each([
    "[guide](https://example.test)\nUse `code` here.",
    "[guide][reference]\n\n[reference]: https://example.test\n\n```js\nconst x = {};\n```",
    "[section]\nOrdinary prose with `code`.",
    "[tool:read]\n",
  ])("does not resolve Markdown ownership without a bracket payload: %s", (raw) => {
    const resolveProtectedRanges = vi.fn(() => []);

    for (let end = 1; end <= raw.length; end++) {
      const prefix = raw.slice(0, end);
      expectStripped(prefix, prefix, { resolveProtectedRanges });
    }
    expect(resolveProtectedRanges).not.toHaveBeenCalled();
  });

  it.each(['Example [tool:read]{"path":"example.txt"}', '[read]\n{"path":}\n[/read]'])(
    "preserves non-call text: %s",
    (raw) => expectStripped(raw),
  );

  it.each(["\r", "\r\n"])("strips Unicode-indented bracket calls after %j", (lineBreak) => {
    const prefix = `Before${lineBreak}`;
    const suffix = `${lineBreak}After`;
    const json = `[read]${lineBreak}{"path":"example.txt"}[/read]`;
    const xml = "[tool:read]<parameter=path>example.txt</parameter>";
    const adjacent = '[tool:write]{"path":"output.txt"}';

    expectStripped(`${prefix}\u00a0\t${json}${suffix}`, `${prefix}After`);
    expectStripped(`${prefix}\u2003${xml} ${adjacent}${suffix}`, `${prefix}After`);
  });

  it("preserves protected candidates while stripping adjacent unprotected calls", () => {
    const protectedCall = '[read]\n{"path":"example.txt"}\n[/read]';
    const unprotectedCall = '[read]\n{"path":"secret.txt"}\n[/read]';
    const raw = [protectedCall, unprotectedCall].join("\n");

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

  it.each([
    [
      "XML",
      "<function=read><parameter=x>x\n".repeat(256) + "</parameter>X",
      "indexOfCalls",
      256 * 8,
    ],
    ["JSON", "[read]\n{\n".repeat(256) + "}".repeat(256) + "[/wrong]", "indexedReads", undefined],
  ] as const)("advances once through a far-invalid %s payload", (_name, raw, counter, limit) => {
    const tracked = trackStringOperations(raw);
    expectStripped(tracked.text, raw);
    expect(tracked.counts[counter]).toBeLessThan(limit ?? raw.length * 16);
  });
});

describe("projectPlainTextToolCallBlocks", () => {
  it.each([
    ["[read]\n\n", "[read]\n\n"],
    ["[tool:read] {}\n", ""],
    ["[tool:read] {}\n[", "[tool:read] {}\n["],
    ["[tool:read]<parameter=x>value</parameter>\n", ""],
    ["[read]\n{}[/read] [write]\n", " [write]\n"],
  ])("retains calls whose suffix can change the projection: %s", (pending, visible) => {
    const prefix = "Before\n";
    expect(projection(prefix + pending)).toEqual([prefix + visible, prefix.length, prefix.length]);
  });

  it("reports source and output boundaries after a settled removed line", () => {
    const settled = "Before\n[read]\n{}[/read]\n";
    const before = "Before\n".length;
    expect(projection(`${settled}Tail`)).toEqual(["Before\nTail", settled.length, before]);
    expect(projection(`${settled}Tail`, before)).toEqual(["Before\nTail", before, before]);
  });

  it("retains a terminal CR until newline consumption settles", () => {
    const source = "[read]\n{}[/read]\r";
    expect(projection(source)).toEqual(["", 0, 0]);
    expect(projection(`${source}\n`)).toEqual(["", source.length + 1, 0]);
  });
});

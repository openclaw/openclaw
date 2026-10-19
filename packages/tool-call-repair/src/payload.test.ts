import { describe, expect, it, vi } from "vitest";
import {
  projectPlainTextToolCallBlocks,
  scanPlainTextJsonToolCall,
  stripPlainTextToolCallBlocks,
} from "./payload.js";

function trackStringOperations(value: string) {
  const counts = { indexedReads: 0, indexOfCalls: 0 };
  const source = Object(value) as object;
  const text = new Proxy(source, {
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

function expectProjection(
  raw: string,
  text: string,
  retainStart: number,
  retainedOutputStart = 0,
  options?: Parameters<typeof projectPlainTextToolCallBlocks>[1],
) {
  expect(projectPlainTextToolCallBlocks(raw, options)).toEqual({
    text,
    retainStart,
    retainedOutputStart,
  });
}

describe("scanPlainTextJsonToolCall", () => {
  it("returns the complete Harmony call before a visible suffix", () => {
    const raw = '<|channel|>commentary to=read code<|message|>{"path":"/tmp/file"}<|call|>visible';
    const scan = scanPlainTextJsonToolCall(raw);

    expect(scan.kind).toBe("complete");
    if (scan.kind !== "complete") {
      return;
    }
    expect(raw.slice(scan.end)).toBe("visible");
    expect(raw.slice(scan.name.start, scan.name.end)).toBe("read");
    expect(raw.slice(scan.payload.start, scan.payload.end)).toBe('{"path":"/tmp/file"}');
  });

  it("classifies the streaming Harmony prefix", () => {
    const raw = "commentary to=read co";
    const scan = scanPlainTextJsonToolCall(raw);

    expect(scan.kind).toBe("prefix");
    if (scan.kind !== "prefix") {
      return;
    }
    expect(scan.candidate).toMatchObject({ syntax: "harmony", nameComplete: true });
    expect(
      scan.candidate?.name
        ? raw.slice(scan.candidate.name.start, scan.candidate.name.end)
        : undefined,
    ).toBe("read");
  });

  it.each([
    (name: string) => `[${name}]\n{}[/${name}]`,
    (name: string) => `analysis to=${name} code {}`,
  ])("accepts 120-character names and rejects the 121st character", (build) => {
    expect(scanPlainTextJsonToolCall(build("x".repeat(120))).kind).toBe("complete");
    const oversized = scanPlainTextJsonToolCall(build("x".repeat(121)));
    expect(oversized.kind).toBe("invalid");
    if (oversized.kind === "invalid") {
      expect(oversized.at).toBeGreaterThan(0);
    }
  });
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

  it("preserves inline bracket text", () => {
    expectStripped('Example [tool:read]{"path":"example.txt"}');
  });

  it.each([
    ["CR", "\r"],
    ["CRLF", "\r\n"],
  ])("strips Unicode-indented bracket calls after %s", (_name, lineBreak) => {
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

  it("preserves a balanced tool block whose JSON is invalid", () => {
    expectStripped('[read]\n{"path":}\n[/read]');
  });

  it("preserves a long repeated incomplete JSON candidate in one scan", () => {
    const raw = "[tool:read] {\n".repeat(20_000);
    const result = scanPlainTextJsonToolCall(raw);

    expect(result.kind).toBe("prefix");
    if (result.kind !== "prefix") {
      return;
    }
    expect(result.candidate?.payload?.end).toBe(raw.length);
    expectStripped(raw);
  });

  it("advances once through a far-invalid XML parameter", () => {
    const repeats = 256;
    const raw = "<function=read><parameter=x>x\n".repeat(repeats) + "</parameter>X";
    const tracked = trackStringOperations(raw);

    expectStripped(tracked.text, raw);
    expect(tracked.counts.indexOfCalls).toBeLessThan(repeats * 8);
  });

  it("advances once through a far-invalid named JSON payload", () => {
    const repeats = 256;
    const raw = "[read]\n{\n".repeat(repeats) + "}".repeat(repeats) + "[/wrong]";
    const tracked = trackStringOperations(raw);

    expectStripped(tracked.text, raw);
    expect(tracked.counts.indexedReads).toBeLessThan(raw.length * 16);
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
    expectProjection(prefix + pending, prefix + visible, prefix.length, prefix.length);
  });

  it("reports source and output boundaries after a settled removed line", () => {
    const settled = "Before\n[read]\n{}[/read]\n";
    const before = "Before\n".length;
    expectProjection(`${settled}Tail`, "Before\nTail", settled.length, before);
    expectProjection(`${settled}Tail`, "Before\nTail", before, before, {
      settleBefore: before,
    });
  });

  it("retains a terminal CR until newline consumption settles", () => {
    const source = "[read]\n{}[/read]\r";
    expectProjection(source, "", 0);
    expectProjection(`${source}\n`, "", source.length + 1);
  });
});

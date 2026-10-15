import { describe, expect, it, vi } from "vitest";
import { scanPlainTextJsonToolCall, stripPlainTextToolCallBlocks } from "./payload.js";

function trackStringOperations(value: string) {
  let indexedReads = 0;
  let indexOfCalls = 0;
  const source = Object(value) as object;
  const text = new Proxy(source, {
    get(target, property) {
      if (typeof property === "string" && /^(?:0|[1-9]\d*)$/.test(property)) {
        indexedReads += 1;
      }
      if (property === "indexOf") {
        return (searchString: string, position?: number) => {
          indexOfCalls += 1;
          return value.indexOf(searchString, position);
        };
      }
      const member = Reflect.get(target, property, target) as unknown;
      return typeof member === "function" ? member.bind(target) : member;
    },
  });
  return {
    get indexedReads() {
      return indexedReads;
    },
    get indexOfCalls() {
      return indexOfCalls;
    },
    text: text as unknown as string,
  };
}

describe("scanPlainTextJsonToolCall", () => {
  it.each([
    ["Harmony", '<|channel|>commentary to=read code<|message|>{"path":"/tmp/file"}<|call|>visible'],
  ])("returns the complete %s call before a visible suffix", (_syntax, raw) => {
    const scan = scanPlainTextJsonToolCall(raw);

    expect(scan.kind).toBe("complete");
    if (scan.kind !== "complete") {
      return;
    }
    expect(raw.slice(scan.end)).toBe("visible");
    expect(raw.slice(scan.name.start, scan.name.end)).toBe("read");
    expect(raw.slice(scan.payload.start, scan.payload.end)).toBe('{"path":"/tmp/file"}');
  });

  it.each([["commentary to=read co", "harmony", "read", true]] as const)(
    "classifies the streaming prefix %s",
    (raw, syntax, name, nameComplete) => {
      const scan = scanPlainTextJsonToolCall(raw);

      expect(scan.kind).toBe("prefix");
      if (scan.kind !== "prefix") {
        return;
      }
      expect(scan.candidate?.syntax).toBe(syntax);
      expect(scan.candidate?.nameComplete).toBe(nameComplete);
      expect(
        scan.candidate?.name
          ? raw.slice(scan.candidate.name.start, scan.candidate.name.end)
          : undefined,
      ).toBe(name);
    },
  );

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
  it.each([
    "[guide](https://example.test)\nUse `code` here.",
    "[guide][reference]\n\n[reference]: https://example.test\n\n```js\nconst x = {};\n```",
    "[section]\nOrdinary prose with `code`.",
    "[tool:read]\n",
  ])("does not resolve Markdown ownership without a bracket payload: %s", (raw) => {
    const resolveProtectedRanges = vi.fn(() => []);

    for (let end = 1; end <= raw.length; end++) {
      const prefix = raw.slice(0, end);
      expect(stripPlainTextToolCallBlocks(prefix, { resolveProtectedRanges })).toBe(prefix);
    }
    expect(resolveProtectedRanges).not.toHaveBeenCalled();
  });

  it.each(['Example [tool:read]{"path":"example.txt"}'])(
    "preserves inline bracket text: %s",
    (raw) => {
      expect(stripPlainTextToolCallBlocks(raw)).toBe(raw);
    },
  );

  it.each([
    ["CR", "\r"],
    ["CRLF", "\r\n"],
  ])("strips Unicode-indented bracket calls after %s", (_name, lineBreak) => {
    const prefix = `Before${lineBreak}`;
    const suffix = `${lineBreak}After`;
    const json = `[read]${lineBreak}{"path":"example.txt"}[/read]`;
    const xml = "[tool:read]<parameter=path>example.txt</parameter>";
    const adjacent = '[tool:write]{"path":"output.txt"}';

    expect(stripPlainTextToolCallBlocks(`${prefix}\u00a0\t${json}${suffix}`)).toBe(
      `${prefix}After`,
    );
    expect(stripPlainTextToolCallBlocks(`${prefix}\u2003${xml} ${adjacent}${suffix}`)).toBe(
      `${prefix}After`,
    );
  });

  it("preserves protected candidates while stripping adjacent unprotected calls", () => {
    const protectedCall = '[read]\n{"path":"example.txt"}\n[/read]';
    const unprotectedCall = '[read]\n{"path":"secret.txt"}\n[/read]';
    const raw = [protectedCall, unprotectedCall].join("\n");

    expect(
      stripPlainTextToolCallBlocks(raw, {
        resolveProtectedRanges: () => [{ start: 0, end: protectedCall.length }],
      }),
    ).toBe(`${protectedCall}\n`);
    expect(stripPlainTextToolCallBlocks(raw)).toBe("");
  });

  it("preserves a balanced tool block whose JSON is invalid", () => {
    const raw = '[read]\n{"path":}\n[/read]';

    expect(stripPlainTextToolCallBlocks(raw)).toBe(raw);
  });

  it.each([["JSON", "[tool:read] {\n", scanPlainTextJsonToolCall]] as const)(
    "preserves a long repeated incomplete %s candidate in one scan",
    (_name, line, scan) => {
      const raw = line.repeat(20_000);
      const result = scan(raw);

      expect(result.kind).toBe("prefix");
      if (result.kind !== "prefix") {
        return;
      }
      expect(result.candidate?.payload?.end).toBe(raw.length);
      expect(stripPlainTextToolCallBlocks(raw)).toBe(raw);
    },
  );

  it("advances once through a far-invalid XML parameter", () => {
    const repeats = 256;
    const raw = "<function=read><parameter=x>x\n".repeat(repeats) + "</parameter>X";
    const tracked = trackStringOperations(raw);

    expect(stripPlainTextToolCallBlocks(tracked.text)).toBe(raw);
    expect(tracked.indexOfCalls).toBeLessThan(repeats * 8);
  });

  it("advances once through a far-invalid named JSON payload", () => {
    const repeats = 256;
    const raw = "[read]\n{\n".repeat(repeats) + "}".repeat(repeats) + "[/wrong]";
    const tracked = trackStringOperations(raw);

    expect(stripPlainTextToolCallBlocks(tracked.text)).toBe(raw);
    expect(tracked.indexedReads).toBeLessThan(raw.length * 16);
  });
});

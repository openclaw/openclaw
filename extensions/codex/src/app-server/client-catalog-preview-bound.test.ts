import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { describe, expect, it } from "vitest";
import {
  selectCodexCatalogPreviewInput,
  truncateCodexCatalogPreview,
} from "../session-catalog-parsing.js";
import {
  CodexCatalogPreviewBounder,
  type CodexCatalogPreviewBoundLimits,
} from "./client-catalog-preview-bound.js";
import { createCodexCatalogDecoder } from "./client-catalog-response.js";

function threadList(preview: string, extra?: Record<string, unknown>) {
  return JSON.stringify({
    id: 1,
    result: { data: [{ id: "thread-1", preview, ...extra }] },
  });
}

function boundPreviews(text: string, limits?: Partial<CodexCatalogPreviewBoundLimits>): string {
  return new CodexCatalogPreviewBounder(limits).push(text);
}

function displayedPreview(preview: string): string {
  return truncateCodexCatalogPreview(selectCodexCatalogPreviewInput(preview), sanitizeTerminalText);
}

function boundedPreview(preview: string): string {
  const parsed = JSON.parse(boundPreviews(threadList(preview))) as {
    result: { data: Array<{ preview: string }> };
  };
  return parsed.result.data[0]!.preview;
}

function catalogBytes(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
}

describe("Codex catalog preview JSON bounding", () => {
  it("truncates preview strings so oversized thread/list pages remain parseable", () => {
    const raw = threadList("x".repeat(50_000));
    const bounded = boundPreviews(raw, { prefixUnits: 16, displayUnits: 4 });
    const parsed = JSON.parse(bounded) as {
      result: { data: Array<{ id: string; preview: string }> };
    };
    expect(parsed.result.data[0]).toEqual({ id: "thread-1", preview: "x".repeat(16) });
    expect(bounded.length).toBeLessThan(raw.length);
  });

  it("leaves non-preview strings and escaped preview quotes intact", () => {
    const raw = JSON.stringify({
      id: 1,
      result: {
        unused: "u".repeat(200),
        data: [{ id: "thread-1", name: "preview", preview: 'say "hi"' }],
      },
    });
    expect(JSON.parse(boundPreviews(raw, { prefixUnits: 32, displayUnits: 4 }))).toEqual(
      JSON.parse(raw),
    );
  });

  it("skips escaped quotes inside an oversized preview without ending the string", () => {
    const raw = JSON.stringify({
      id: 1,
      result: {
        data: [{ id: "thread-1", preview: `hello "world" ${"x".repeat(200)}`, cwd: "/tmp" }],
      },
    });
    const parsed = JSON.parse(boundPreviews(raw, { prefixUnits: 13, displayUnits: 4 })) as {
      result: { data: Array<{ id: string; preview: string; cwd: string }> };
    };
    expect(parsed.result.data[0]).toEqual({
      id: "thread-1",
      preview: 'hello "world"',
      cwd: "/tmp",
    });
  });

  it("skips the remainder of a preview across chunks until the closing quote", () => {
    const bounder = new CodexCatalogPreviewBounder({ prefixUnits: 4, displayUnits: 2 });
    const first = bounder.push('{"result":{"data":[{"id":"thread-1","preview":"abcd');
    const middle = bounder.push(`${"x".repeat(8_000)}more`);
    const last = bounder.push('tail","cwd":"/tmp"}]}}');
    const parsed = JSON.parse(`${first}${middle}${last}`) as {
      result: { data: Array<{ preview: string; cwd: string }> };
    };
    expect(middle).toBe("");
    expect(parsed.result.data[0]).toEqual({ id: "thread-1", preview: "abcd", cwd: "/tmp" });
  });

  it("does not count skipped preview fragments against incomplete-frame recovery", () => {
    const decode = createCodexCatalogDecoder();
    const first = decode({
      bytes: catalogBytes(
        `{"id":1,"result":{"data":[{"id":"thread-1","preview":"${"x".repeat(8_000)}`,
      ),
      route: "unresolved",
    });
    expect(first.pending).toBe(true);
    expect(first.failures).toEqual([]);
    for (let index = 0; index < 1_001; index++) {
      const skipped = decode({ bytes: catalogBytes("more\npreview"), route: "unresolved" });
      expect(skipped.pending).toBe(true);
      expect(skipped.failures).toEqual([]);
    }
    const complete = decode({
      bytes: catalogBytes('end","cwd":"/tmp"}]}}'),
      route: "unresolved",
    });
    expect(complete.failures).toEqual([]);
    expect(complete.pending).toBe(false);
    expect(complete.message).toMatchObject({
      result: { data: [{ id: "thread-1", cwd: "/tmp" }] },
    });
  });

  it.each([
    ["plain text", "x".repeat(50_000)],
    ["a whitespace-heavy prefix", `${" ".repeat(2_048)}meaningful ${"text ".repeat(400)}`],
    ["escaped newlines in the prefix", `${"\n".repeat(3_000)}after ${"y".repeat(5_000)}`],
    ["sparse words across the prefix", `${"a     ".repeat(1_000)}${"b".repeat(5_000)}`],
    ["a terminal control in the prefix", `\u001b[31mred\u001b[0m ${"z".repeat(100_000)}`],
    ["a surrogate pair at the display boundary", `${"x".repeat(499)}😀${"y".repeat(5_000)}`],
    ["text after a whitespace run beyond the fallback cap", `${" ".repeat(70_000)}meaningful`],
    ["text after escaped newlines beyond the fallback cap", `${"\n".repeat(70_000)}meaningful`],
    [
      "text after removable controls beyond the fallback cap",
      `${"\u0007".repeat(15_000)}meaningful text`,
    ],
    [
      "removable controls between whitespace runs",
      `a ${"\u0007".repeat(20_000)} b ${"y".repeat(5_000)}`,
    ],
    [
      "removable controls before an ANSI sequence",
      `${"\u0001".repeat(15_000)}\u001b[1mbold\u001b[0m ${"z".repeat(100_000)}`,
    ],
  ])("keeps the displayed preview unchanged for %s", (_name, preview) => {
    expect(boundedPreview(preview)).not.toBe(preview);
    expect(displayedPreview(boundedPreview(preview))).toBe(displayedPreview(preview));
  });

  it("keeps short text after a long whitespace prefix", () => {
    const preview = `${" ".repeat(3_000)}short`;
    expect(boundedPreview(preview)).toBe(" short");
    expect(displayedPreview(boundedPreview(preview))).toBe("short");
  });

  it("still bounds control-only previews that never determine the display", () => {
    const preview = "\u0007".repeat(100_000);
    const raw = threadList(preview);
    const bounded = boundPreviews(raw);
    expect(bounded.length).toBeLessThan(70 * 1024);
    expect(displayedPreview(boundedPreview(preview))).toBe(displayedPreview(preview));
  });

  it("does not count whitespace-only preview lines against incomplete-frame recovery", () => {
    const decode = createCodexCatalogDecoder();
    const first = decode({
      bytes: catalogBytes('{"id":1,"result":{"data":[{"id":"thread-1","preview":"start'),
      route: "unresolved",
    });
    expect(first.pending).toBe(true);
    for (let index = 0; index < 1_500; index++) {
      const blank = decode({ bytes: catalogBytes("    "), route: "unresolved" });
      expect(blank.pending).toBe(true);
      expect(blank.failures).toEqual([]);
    }
    const complete = decode({
      bytes: catalogBytes('meaningful","cwd":"/tmp"}]}}'),
      route: "unresolved",
    });
    expect(complete.failures).toEqual([]);
    expect(complete.pending).toBe(false);
    expect(complete.message).toMatchObject({
      result: { data: [{ id: "thread-1", cwd: "/tmp" }] },
    });
    const { preview } = (complete.message as { result: { data: Array<{ preview: string }> } })
      .result.data[0]!;
    const unbounded = ["start", ...Array.from({ length: 1_500 }, () => "    "), "meaningful"];
    expect(displayedPreview(preview)).toBe(displayedPreview(unbounded.join("\n")));
    expect(displayedPreview(preview)).toBe("start meaningful");
  });
});

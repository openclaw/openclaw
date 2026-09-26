import { describe, expect, it } from "vitest";
import { CodexCatalogPreviewBounder } from "./client-catalog-preview-bound.js";
import { createCodexCatalogDecoder } from "./client-catalog-response.js";

function threadList(preview: string, extra?: Record<string, unknown>) {
  return JSON.stringify({
    id: 1,
    result: { data: [{ id: "thread-1", preview, ...extra }] },
  });
}

function boundPreviews(text: string, maxPreviewChars: number): string {
  return new CodexCatalogPreviewBounder(maxPreviewChars).push(text);
}

function catalogBytes(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text) as Uint8Array<ArrayBuffer>;
}

describe("Codex catalog preview JSON bounding", () => {
  it("truncates preview strings so oversized thread/list pages remain parseable", () => {
    const raw = threadList("x".repeat(50_000));
    const bounded = boundPreviews(raw, 16);
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
    expect(JSON.parse(boundPreviews(raw, 32))).toEqual(JSON.parse(raw));
  });

  it("skips escaped quotes inside an oversized preview without ending the string", () => {
    const raw = JSON.stringify({
      id: 1,
      result: {
        data: [{ id: "thread-1", preview: `hello "world" ${"x".repeat(200)}`, cwd: "/tmp" }],
      },
    });
    const parsed = JSON.parse(boundPreviews(raw, 15)) as {
      result: { data: Array<{ id: string; preview: string; cwd: string }> };
    };
    expect(parsed.result.data[0]).toEqual({
      id: "thread-1",
      preview: 'hello "world"',
      cwd: "/tmp",
    });
  });

  it("skips the remainder of a preview across chunks until the closing quote", () => {
    const bounder = new CodexCatalogPreviewBounder(4);
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
});

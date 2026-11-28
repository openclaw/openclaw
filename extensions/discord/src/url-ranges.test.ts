import { describe, expect, it } from "vitest";
import { findDiscordUrlRanges } from "./url-ranges.js";

function urls(text: string): string[] {
  return findDiscordUrlRanges(text).map(({ start, end }) => text.slice(start, end));
}

describe("findDiscordUrlRanges", () => {
  it("finds bare URLs and keeps nested URL starts inside the outer range", () => {
    expect(urls("see https://a.b/x//y?u=www.c.d, mailto:a@b.c and -ftp://h (x)")).toEqual([
      "https://a.b/x//y?u=www.c.d",
      "mailto:a@b.c",
      "ftp://h",
    ]);
    expect(urls("1http://a.b x_http://c.d e__www.f.g")).toEqual(["www.f.g"]);
  });

  it("scans long slash, www. and letter runs in linear time", () => {
    const runs = ["/".repeat(32_000), "www.".repeat(8_000), "a".repeat(32_000)];
    const startedAt = performance.now();
    const counts = runs.map((run) => findDiscordUrlRanges(run).length);
    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(counts).toEqual([1, 1, 0]);
  });
});

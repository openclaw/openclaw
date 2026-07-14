import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createCachedExecutableResolver } from "./executables.js";

describe("linux-node executable discovery", () => {
  it("caches PATH probes per process environment", () => {
    const expected = path.join("/usr/bin", "ffmpeg");
    const isExecutable = vi.fn((candidate: string) => candidate === expected);
    const resolve = createCachedExecutableResolver(isExecutable);
    const env = { PATH: "/usr/local/bin:/usr/bin" };

    expect(resolve("ffmpeg", env)).toBe(expected);
    expect(resolve("ffmpeg", env)).toBe(expected);
    expect(isExecutable).toHaveBeenCalledTimes(2);
  });

  it("checks known GeoClue demo paths after PATH", () => {
    const demo = "/usr/libexec/geoclue-2.0/demos/where-am-i";
    const resolve = createCachedExecutableResolver((candidate) => candidate === demo);
    expect(resolve("where-am-i", { PATH: "/usr/bin" }, [demo])).toBe(demo);
  });
});

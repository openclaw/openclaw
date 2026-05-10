import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { decodeOpusStream } from "./audio.js";

describe("discord voice opus decoder selection", () => {
  it("prefers the pure-JS opusscript decoder over optional native opus", async () => {
    const verbose: string[] = [];
    const warnings: string[] = [];

    const decoded = await decodeOpusStream(Readable.from([]), {
      onVerbose: (message) => verbose.push(message),
      onWarn: (message) => warnings.push(message),
    });

    expect(decoded.length).toBe(0);
    expect(verbose).toContain("opus decoder: opusscript");
    expect(warnings).toEqual([]);
  });
});

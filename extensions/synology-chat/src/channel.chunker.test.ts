import { describe, expect, it } from "vitest";
import { synologyChatPlugin } from "./channel.js";

describe("synology-chat outbound markdown chunking", () => {
  it("keeps fenced code blocks balanced when a reply crosses the chunk limit", () => {
    const outbound = synologyChatPlugin.outbound;
    expect(outbound?.chunkerMode).toBe("markdown");
    const chunker = outbound?.chunker;
    expect(chunker).toBeDefined();

    const fenced = "```py\n  a\n  b\n```\n\nend";
    expect(chunker!(fenced, 14)).toEqual(["```py\n  a\n```", "```py\n  b\n```", "end"]);
  });
});

import { describe, it, expect } from "vitest";
import { extractMatrixUserMentions, applyMatrixMentions } from "./formatting.js";

describe("extractMatrixUserMentions", () => {
  it("extracts single user mention", () => {
    expect(extractMatrixUserMentions("Hello @alice:example.com!")).toEqual(["@alice:example.com"]);
  });

  it("extracts multiple unique mentions", () => {
    const result = extractMatrixUserMentions("cc @alice:example.com and @bob:matrix.org");
    expect(result).toEqual(["@alice:example.com", "@bob:matrix.org"]);
  });

  it("deduplicates mentions", () => {
    const result = extractMatrixUserMentions("@alice:example.com said hi to @alice:example.com");
    expect(result).toEqual(["@alice:example.com"]);
  });

  it("returns empty array for no mentions", () => {
    expect(extractMatrixUserMentions("just some text")).toEqual([]);
  });

  it("returns empty array for empty/null input", () => {
    expect(extractMatrixUserMentions("")).toEqual([]);
  });

  it("handles complex localparts", () => {
    expect(extractMatrixUserMentions("@user_name.test=foo/bar:server.example.org")).toEqual([
      "@user_name.test=foo/bar:server.example.org",
    ]);
  });
});

describe("applyMatrixMentions", () => {
  it("adds m.mentions to content with user mentions", () => {
    const content: Record<string, unknown> = { msgtype: "m.text", body: "hi @alice:example.com" };
    applyMatrixMentions(content, "hi @alice:example.com");
    expect(content["m.mentions"]).toEqual({ user_ids: ["@alice:example.com"] });
  });

  it("does not add m.mentions when no mentions present", () => {
    const content: Record<string, unknown> = { msgtype: "m.text", body: "hello" };
    applyMatrixMentions(content, "hello");
    expect(content["m.mentions"]).toBeUndefined();
  });
});

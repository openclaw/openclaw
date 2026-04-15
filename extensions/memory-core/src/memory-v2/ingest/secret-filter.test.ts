import { describe, expect, it } from "vitest";
import { looksLikeSecret } from "./secret-filter.js";

describe("looksLikeSecret", () => {
  it("flags sk-prefixed tokens", () => {
    expect(looksLikeSecret("my key is sk-AbCdEfGhIjKlMnOp1234")).toBe(true);
  });

  it("flags Slack tokens", () => {
    expect(looksLikeSecret("token=xoxb-1234567890-abcdefghijk")).toBe(true);
  });

  it("flags GitHub PATs", () => {
    expect(looksLikeSecret("PAT: ghp_abcdefghijklmnopqrstuvwxyz1234")).toBe(true);
  });

  it("flags JWTs", () => {
    expect(looksLikeSecret("Bearer eyJabcdefgh.abcdefghIJK.signaturePart12")).toBe(true);
  });

  it("flags long opaque mixed-case+digit runs", () => {
    expect(looksLikeSecret("session=AbCdEfGh12345678IjKlMnOpQrStUv")).toBe(true);
  });

  it("does not flag ordinary prose", () => {
    expect(looksLikeSecret("my name is Alex and I prefer dark mode")).toBe(false);
  });

  it("does not flag code-shaped identifiers", () => {
    expect(looksLikeSecret("call my_function_name with the value")).toBe(false);
  });

  it("does not flag short hex-ish tokens", () => {
    expect(looksLikeSecret("commit abc123 was bad")).toBe(false);
  });
});

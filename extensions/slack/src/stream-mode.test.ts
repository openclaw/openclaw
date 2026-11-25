// Slack tests cover stream mode plugin behavior.
import { describe, expect, it } from "vitest";
import { applyAppendOnlyStreamUpdate, resolveSlackStreamingConfig } from "./stream-mode.js";

describe("resolveSlackStreamingConfig", () => {
  it("defaults to progress mode with native streaming enabled", () => {
    expect(resolveSlackStreamingConfig({})).toEqual({
      mode: "progress",
      nativeStreaming: true,
    });
  });

  it("keeps explicit partial mode on the replace draft path", () => {
    expect(
      resolveSlackStreamingConfig({ streaming: { mode: "partial", nativeTransport: false } }),
    ).toEqual({
      mode: "partial",
      nativeStreaming: false,
    });
  });
});

describe("applyAppendOnlyStreamUpdate", () => {
  for (const { name, input, expected } of [
    {
      name: "starts with first incoming text",
      input: { incoming: "hello", rendered: "", source: "" },
      expected: { rendered: "hello", source: "hello", changed: true },
    },
    {
      name: "uses cumulative incoming text when it extends prior source",
      input: { incoming: "hello world", rendered: "hello", source: "hello" },
      expected: { rendered: "hello world", source: "hello world", changed: true },
    },
    {
      name: "ignores regressive shorter incoming text",
      input: { incoming: "hello", rendered: "hello world", source: "hello world" },
      expected: { rendered: "hello world", source: "hello world", changed: false },
    },
    {
      name: "extends rendered when source continues after an appended chunk",
      input: {
        incoming: "next chunk grows",
        rendered: "hello world\nnext chunk",
        source: "next chunk",
      },
      expected: {
        rendered: "hello world\nnext chunk grows",
        source: "next chunk grows",
        changed: true,
      },
    },
    {
      name: "appends non-prefix incoming chunks",
      input: { incoming: "next chunk", rendered: "hello world", source: "hello world" },
      expected: { rendered: "hello world\nnext chunk", source: "next chunk", changed: true },
    },
  ]) {
    it(name, () => {
      // Keep each invocation's input and expectation fresh, including retries.
      const next = applyAppendOnlyStreamUpdate({ ...input });
      expect(next).toEqual({ ...expected });
    });
  }
});

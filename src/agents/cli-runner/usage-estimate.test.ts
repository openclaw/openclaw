/**
 * Tests for backend-owned usage estimator helper.
 *
 * Covers the `CliBackendPlugin.estimateUsage` hook: a backend can supply a
 * token-count heuristic for text-output CLIs (e.g. agy) whose stdout carries
 * no structured usage. The helper is pure so it tests cleanly without I/O.
 */
import { describe, expect, it, vi } from "vitest";
import type { CliBackendPlugin } from "../../plugins/cli-backend.types.js";
import type { CliOutput } from "../cli-output.js";
import { applyBackendEstimateUsage } from "./usage-estimate.js";

function makeOutput(overrides: Partial<CliOutput> = {}): CliOutput {
  return { text: "hello world", ...overrides };
}

describe("applyBackendEstimateUsage", () => {
  it("returns output unchanged when backend has no estimator", () => {
    const out = makeOutput();
    const result = applyBackendEstimateUsage(
      { id: "no-estimator" } as Pick<CliBackendPlugin, "id" | "estimateUsage">,
      out,
      { promptText: "prompt", modelId: "gemini-3.5-flash" },
    );
    expect(result).toBe(out);
    expect(result.usage).toBeUndefined();
  });

  it("returns output unchanged when usage is already present", () => {
    const out = makeOutput({ usage: { input: 7, output: 3, total: 10 } });
    const estimator = vi.fn();
    const result = applyBackendEstimateUsage(
      { id: "json-backend", estimateUsage: estimator } as Pick<
        CliBackendPlugin,
        "id" | "estimateUsage"
      >,
      out,
      { promptText: "prompt", modelId: "gemini-3.5-flash" },
    );
    expect(result).toBe(out);
    expect(estimator).not.toHaveBeenCalled();
  });

  it("fills usage from the backend estimator when output.usage is undefined", () => {
    const estimator = vi.fn().mockReturnValue({ input: 5, output: 3, total: 8, estimated: true });
    const out = makeOutput({ text: "abc" });
    const result = applyBackendEstimateUsage(
      { id: "text-backend", estimateUsage: estimator } as Pick<
        CliBackendPlugin,
        "id" | "estimateUsage"
      >,
      out,
      { promptText: "twenty-character-pr", modelId: "gemini-3.5-flash" },
    );
    expect(estimator).toHaveBeenCalledWith({
      promptText: "twenty-character-pr",
      assistantText: "abc",
      modelId: "gemini-3.5-flash",
    });
    expect(result.usage).toEqual({ input: 5, output: 3, total: 8, estimated: true });
    expect(result.text).toBe("abc");
  });

  it("preserves the estimated marker so UI can distinguish heuristic counts from exact usage", () => {
    // Maintainer concern (clawsweeper review on #91282): estimates must not
    // be presentable as exact provider billing data. The `estimated: true`
    // discriminator survives through the wiring untouched.
    const estimator = vi.fn().mockReturnValue({ total: 42, estimated: true });
    const out = makeOutput();
    const result = applyBackendEstimateUsage(
      { id: "text-backend", estimateUsage: estimator } as Pick<
        CliBackendPlugin,
        "id" | "estimateUsage"
      >,
      out,
      { promptText: "p", modelId: "gemini-3.5-flash" },
    );
    expect(result.usage).toMatchObject({ estimated: true });
  });

  it("leaves usage unset when the estimator returns undefined", () => {
    const estimator = vi.fn().mockReturnValue(undefined);
    const out = makeOutput();
    const result = applyBackendEstimateUsage(
      { id: "shy-backend", estimateUsage: estimator } as Pick<
        CliBackendPlugin,
        "id" | "estimateUsage"
      >,
      out,
      { promptText: "prompt", modelId: "gemini-3.5-flash" },
    );
    expect(estimator).toHaveBeenCalled();
    expect(result.usage).toBeUndefined();
  });

  it("is a no-op when backend itself is undefined", () => {
    const out = makeOutput();
    const result = applyBackendEstimateUsage(undefined, out, {
      promptText: "prompt",
      modelId: "gemini-3.5-flash",
    });
    expect(result).toBe(out);
  });

  it("models the chars/4 Gemini heuristic when used as an estimator", () => {
    // Documents the intended Antigravity-backend default (Google's official
    // "1 token ≈ 4 characters" rule). The helper is heuristic-agnostic; this
    // test just shows the wiring carries the heuristic through unchanged.
    const out = makeOutput({ text: "abcdefgh" });
    const result = applyBackendEstimateUsage(
      {
        id: "chars-4",
        estimateUsage: ({ promptText, assistantText }) => {
          const input = Math.ceil(promptText.length / 4);
          const output = Math.ceil(assistantText.length / 4);
          return { input, output, total: input + output, estimated: true };
        },
      } as Pick<CliBackendPlugin, "id" | "estimateUsage">,
      out,
      { promptText: "abcdefghijklmnop", modelId: "gemini-3.5-flash" },
    );
    expect(result.usage).toEqual({ input: 4, output: 2, total: 6, estimated: true });
  });
});

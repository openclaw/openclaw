import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { resolveEmitsReasoningInContent } from "./model-reasoning-compat.js";

const cfg: OpenClawConfig = {
  models: {
    providers: {
      gpufarm: {
        baseUrl: "http://gpufarm.lan/v1",
        models: [
          { id: "qwen3.8-27b-r9700", compat: { emitsReasoningInContent: true } },
          { id: "qwen38-27b-rtx5090-prod" },
          { id: "explicit-off", compat: { emitsReasoningInContent: false } },
        ],
      },
    },
  },
} as OpenClawConfig;

describe("resolveEmitsReasoningInContent", () => {
  it("opts in for the flagged provider/model row", () => {
    expect(resolveEmitsReasoningInContent(cfg, "gpufarm", "qwen3.8-27b-r9700")).toBe(true);
  });

  it("matches model ids case-insensitively", () => {
    expect(resolveEmitsReasoningInContent(cfg, "gpufarm", "QWEN3.8-27B-R9700")).toBe(true);
  });

  it("stays off for rows without the flag or with it disabled", () => {
    expect(resolveEmitsReasoningInContent(cfg, "gpufarm", "qwen38-27b-rtx5090-prod")).toBe(false);
    expect(resolveEmitsReasoningInContent(cfg, "gpufarm", "explicit-off")).toBe(false);
  });

  it("resolves self-provider-prefixed row ids", () => {
    const prefixed: OpenClawConfig = {
      models: {
        providers: {
          gpufarm: {
            baseUrl: "http://gpufarm.lan/v1",
            models: [{ id: "gpufarm/prefixed-row", compat: { emitsReasoningInContent: true } }],
          },
        },
      },
    } as OpenClawConfig;
    expect(resolveEmitsReasoningInContent(prefixed, "gpufarm", "prefixed-row")).toBe(true);
  });

  it("returns false for unknown providers, models, or empty input", () => {
    expect(resolveEmitsReasoningInContent(cfg, "unknown", "qwen3.8-27b-r9700")).toBe(false);
    expect(resolveEmitsReasoningInContent(cfg, "gpufarm", "unknown-model")).toBe(false);
    expect(resolveEmitsReasoningInContent(cfg, "", "qwen3.8-27b-r9700")).toBe(false);
    expect(resolveEmitsReasoningInContent(cfg, "gpufarm", "")).toBe(false);
    const empty: OpenClawConfig = {} as OpenClawConfig;
    expect(resolveEmitsReasoningInContent(empty, "gpufarm", "qwen3.8-27b-r9700")).toBe(false);
  });
});

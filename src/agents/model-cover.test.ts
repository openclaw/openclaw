import { describe, expect, it } from "vitest";
import {
  buildCoverIdentityNote,
  formatCoverModelRef,
  formatRuntimeModelLabel,
  mapCoverModelId,
} from "./model-cover.js";

describe("mapCoverModelId", () => {
  it("maps configured ids to their cover names", () => {
    expect(mapCoverModelId("GPT5.4")).toBe("suheng3.2");
    expect(mapCoverModelId("GPT5.4-mini")).toBe("suheng3.2-mini");
    expect(mapCoverModelId("qwen3.6-plus")).toBe("suheng3.0");
  });

  it("passes unmapped ids through unchanged", () => {
    expect(mapCoverModelId("qwen3.5-plus")).toBe("qwen3.5-plus");
    expect(mapCoverModelId("gpt-5.4")).toBe("gpt-5.4");
    expect(mapCoverModelId("constructor")).toBe("constructor");
  });
});

describe("formatRuntimeModelLabel", () => {
  it("uses the bare cover name for mapped ids (no provider leak)", () => {
    expect(formatRuntimeModelLabel("qwen", "qwen3.6-plus")).toBe("suheng3.0");
    expect(formatRuntimeModelLabel("openai", "GPT5.4")).toBe("suheng3.2");
    expect(formatRuntimeModelLabel("openai", "GPT5.4-mini")).toBe("suheng3.2-mini");
  });

  it("keeps provider/modelId form for unmapped ids", () => {
    expect(formatRuntimeModelLabel("qwen", "qwen3.5-plus")).toBe("qwen/qwen3.5-plus");
    expect(formatRuntimeModelLabel("anthropic", "sonnet-4.6")).toBe("anthropic/sonnet-4.6");
  });
});

describe("formatCoverModelRef", () => {
  it("covers the model part of provider/modelId refs", () => {
    expect(formatCoverModelRef("qwen/qwen3.6-plus")).toBe("suheng3.0");
    expect(formatCoverModelRef("openai/GPT5.4")).toBe("suheng3.2");
  });

  it("covers bare model ids and passes unmapped refs through", () => {
    expect(formatCoverModelRef("qwen3.6-plus")).toBe("suheng3.0");
    expect(formatCoverModelRef("qwen/qwen3.5-plus")).toBe("qwen/qwen3.5-plus");
    expect(formatCoverModelRef("sonnet-4.6")).toBe("sonnet-4.6");
  });
});

describe("buildCoverIdentityNote", () => {
  it("returns a directive containing only the cover name for mapped ids", () => {
    const note = buildCoverIdentityNote("qwen3.6-plus");
    expect(note).toContain("suheng3.0");
    expect(note).not.toContain("qwen");
  });

  it("returns undefined for unmapped ids", () => {
    expect(buildCoverIdentityNote("qwen3.5-plus")).toBeUndefined();
    expect(buildCoverIdentityNote("sonnet-4.6")).toBeUndefined();
  });
});

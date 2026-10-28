import { describe, expect, it } from "vitest";
import {
  normalizeGeneratedTopicLabel,
  resolveAutoTopicLabelConfig,
  resolveAutoTopicLabelRefineConfig,
} from "./auto-topic-label-config.js";

describe("resolveAutoTopicLabelRefineConfig", () => {
  it("is opt-in: disabled for boolean or missing config", () => {
    expect(resolveAutoTopicLabelRefineConfig({}).enabled).toBe(false);
    expect(resolveAutoTopicLabelRefineConfig({ directConfig: true }).enabled).toBe(false);
    expect(resolveAutoTopicLabelRefineConfig({ directConfig: false }).enabled).toBe(false);
    expect(resolveAutoTopicLabelRefineConfig({ directConfig: {} }).enabled).toBe(false);
  });

  it("enables only with explicit refine=true", () => {
    expect(resolveAutoTopicLabelRefineConfig({ directConfig: { refine: true } }).enabled).toBe(
      true,
    );
    expect(resolveAutoTopicLabelRefineConfig({ directConfig: { refine: false } }).enabled).toBe(
      false,
    );
  });

  it("falls back to account config when direct omits refinement keys", () => {
    expect(
      resolveAutoTopicLabelRefineConfig({
        directConfig: { enabled: true },
        accountConfig: { refine: true, refineAfterMessages: 4 },
      }),
    ).toEqual({ enabled: true, afterMessages: 4 });
    expect(
      resolveAutoTopicLabelRefineConfig({
        accountConfig: { refine: true, refineAfterMessages: 4 },
      }),
    ).toEqual({ enabled: true, afterMessages: 4 });
  });

  it("defaults threshold and clamps invalid values", () => {
    const cfg = (refineAfterMessages?: number) =>
      resolveAutoTopicLabelRefineConfig({ directConfig: { refine: true, refineAfterMessages } });
    expect(cfg(undefined).afterMessages).toBe(6);
    expect(cfg(0).afterMessages).toBe(6);
    expect(cfg(-1).afterMessages).toBe(6);
    expect(cfg(101).afterMessages).toBe(6);
    expect(cfg(9).afterMessages).toBe(9);
  });
});

describe("resolveAutoTopicLabelConfig per-DM precedence", () => {
  it("a present direct object takes precedence over an account-level false (4304147110)", () => {
    // 4304147110 supersedes 4299713761: requiring enabled:true on a per-DM
    // object silently disabled pre-existing per-DM prompt/refine objects when
    // the account default was false. Only an explicit boolean false or
    // enabled:false disables.
    expect(resolveAutoTopicLabelConfig(undefined, false)).toBeNull();
    expect(resolveAutoTopicLabelConfig({ refine: true }, false)).toEqual({
      enabled: true,
      prompt: expect.any(String),
    });
    expect(resolveAutoTopicLabelConfig({ prompt: "custom" }, false)).toEqual({
      enabled: true,
      prompt: "custom",
    });
    expect(resolveAutoTopicLabelConfig({ enabled: false }, false)).toBeNull();
    expect(resolveAutoTopicLabelConfig(false, false)).toBeNull();
  });

  it("direct explicit enablement keeps precedence over the account default", () => {
    expect(resolveAutoTopicLabelConfig({ enabled: true }, false)).toEqual({
      enabled: true,
      prompt: expect.any(String),
    });
    expect(resolveAutoTopicLabelConfig(false, true)).toBeNull();
    expect(resolveAutoTopicLabelConfig(undefined, true)).toEqual({
      enabled: true,
      prompt: expect.any(String),
    });
  });

  it("literal true enables a DM when the account disables auto-labeling", () => {
    expect(resolveAutoTopicLabelConfig(true, false)).toEqual({
      enabled: true,
      prompt: expect.stringContaining("Generate a very short topic label"),
    });
    expect(resolveAutoTopicLabelConfig(true, { enabled: false, prompt: "Account prompt" })).toEqual(
      {
        enabled: true,
        prompt: "Account prompt",
      },
    );
  });
});

describe("automatic topic output normalization", () => {
  it.each([
    ["YouGile CRM integration planning", "YouGile CRM integration planning"],
    ["Настройка связи с новой CRM", "Настройка связи с новой CRM"],
    ["one—two—three—four", "one—two—three—four"],
    ["CRM API", "CRM API"],
    ["", null],
    ["✨ —", "✨ —"],
  ])("preserves configured prompt output %j", (input, expected) => {
    expect(normalizeGeneratedTopicLabel(input)).toBe(expected);
  });

  it("preserves a suitable existing short name exactly", () => {
    expect(normalizeGeneratedTopicLabel("YouGile  CRM")).toBe("YouGile  CRM");
  });
});

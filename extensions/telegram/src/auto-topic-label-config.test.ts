import { describe, expect, it } from "vitest";
import {
  AUTO_TOPIC_LABEL_REFINE_AFTER_MESSAGES_DEFAULT,
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
    expect(cfg(undefined).afterMessages).toBe(AUTO_TOPIC_LABEL_REFINE_AFTER_MESSAGES_DEFAULT);
    expect(cfg(0).afterMessages).toBe(AUTO_TOPIC_LABEL_REFINE_AFTER_MESSAGES_DEFAULT);
    expect(cfg(-1).afterMessages).toBe(AUTO_TOPIC_LABEL_REFINE_AFTER_MESSAGES_DEFAULT);
    expect(cfg(101).afterMessages).toBe(AUTO_TOPIC_LABEL_REFINE_AFTER_MESSAGES_DEFAULT);
    expect(cfg(9).afterMessages).toBe(9);
  });
});

describe("resolveAutoTopicLabelConfig per-DM precedence", () => {
  it("account-level false disables a direct object without explicit enabled", () => {
    // 4299713761: a DM object like { refine: true } or { prompt: "x" } must
    // not re-enable auto-labelling when the account default is false.
    expect(resolveAutoTopicLabelConfig(undefined, false)).toBeNull();
    expect(resolveAutoTopicLabelConfig({ refine: true }, false)).toBeNull();
    expect(resolveAutoTopicLabelConfig({ prompt: "custom" }, false)).toBeNull();
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

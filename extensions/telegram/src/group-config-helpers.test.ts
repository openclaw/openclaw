import { describe, expect, it } from "vitest";
import {
  resolveTelegramEffectiveUiConfig,
  resolveTelegramScopedAckReaction,
} from "./group-config-helpers.js";

describe("resolveTelegramEffectiveUiConfig", () => {
  it("merges group and topic streaming overrides over account config", () => {
    const effective = resolveTelegramEffectiveUiConfig({
      accountConfig: {
        streaming: {
          mode: "progress",
          preview: { toolProgress: true },
          progress: { toolProgress: true, maxLines: 4 },
        },
      },
      groupConfig: {
        streaming: { mode: "off" },
      },
      topicConfig: {
        streaming: {
          progress: { toolProgress: false },
        },
      },
    });

    expect(effective.streaming).toEqual({
      mode: "off",
      preview: { toolProgress: true },
      progress: { toolProgress: false, maxLines: 4 },
    });
  });

  it("returns the original account config when no scoped UI overrides exist", () => {
    const accountConfig = { streaming: { mode: "progress" as const } };

    expect(resolveTelegramEffectiveUiConfig({ accountConfig })).toBe(accountConfig);
  });
});

describe("resolveTelegramScopedAckReaction", () => {
  it("prefers topic ackReaction over group ackReaction", () => {
    expect(
      resolveTelegramScopedAckReaction({
        groupConfig: { ackReaction: "👀" },
        topicConfig: { ackReaction: "✅" },
      }),
    ).toBe("✅");
  });

  it("preserves null as an explicit disabled ackReaction override", () => {
    expect(resolveTelegramScopedAckReaction({ groupConfig: { ackReaction: null } })).toBeNull();
  });
});

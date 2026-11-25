import { describe, expect, it } from "vitest";
import { resolveCompactionLiveModelSelection } from "./compaction-live-model-selection.js";

const current = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  authProfileId: "anthropic:default",
  authProfileIdSource: "user" as const,
  requiredAuthProfileId: "anthropic:default",
};

describe("resolveCompactionLiveModelSelection", () => {
  it("keeps the active routing when no live switch is pending", () => {
    expect(resolveCompactionLiveModelSelection({ current })).toEqual(current);
  });

  it("uses a pending model and its pinned auth profile", () => {
    expect(
      resolveCompactionLiveModelSelection({
        current,
        requested: {
          provider: "openai",
          model: "gpt-5.5",
          authProfileId: "openai:p1",
          authProfileIdSource: "user",
        },
      }),
    ).toEqual({
      provider: "openai",
      model: "gpt-5.5",
      authProfileId: "openai:p1",
      authProfileIdSource: "user",
    });
  });

  it("drops a stale profile when the pending switch changes providers", () => {
    expect(
      resolveCompactionLiveModelSelection({
        current,
        requested: { provider: "openai", model: "gpt-5.5" },
      }),
    ).toEqual({
      provider: "openai",
      model: "gpt-5.5",
      authProfileIdSource: "auto",
    });
  });

  it("clears the exact requirement when its projection replaces a selected account", () => {
    const selected = resolveCompactionLiveModelSelection({
      current,
      requested: { provider: "anthropic", model: current.model, authProfileId: "anthropic:other" },
    });
    expect({ ...current, ...selected }).toMatchObject({
      authProfileId: "anthropic:other",
      requiredAuthProfileId: undefined,
    });
    const cleared = resolveCompactionLiveModelSelection({
      current,
      requested: { provider: "openai", model: "gpt-5.5" },
    });
    expect({ ...current, ...cleared }).toMatchObject({
      authProfileId: undefined,
      requiredAuthProfileId: undefined,
    });
  });

  it("retains the active profile for a same-provider model switch", () => {
    expect(
      resolveCompactionLiveModelSelection({
        current,
        requested: { provider: "Anthropic", model: "claude-opus-4-6" },
      }),
    ).toEqual({
      ...current,
      provider: "Anthropic",
      model: "claude-opus-4-6",
    });
  });
});

import { describe, expect, it } from "vitest";
import { useChannelStateTestDb } from "../../infra/state-db/test-helpers.channel-state.js";
import {
  readDiscordModelPickerRecentModels,
  recordDiscordModelPickerRecentModel,
} from "./model-picker-preferences.js";

describe("discord model picker preferences", () => {
  useChannelStateTestDb();

  it("records recent models in recency order without duplicates", async () => {
    const scope = { userId: "123" };

    await recordDiscordModelPickerRecentModel({ scope, modelRef: "openai/gpt-4o" });
    await recordDiscordModelPickerRecentModel({ scope, modelRef: "openai/gpt-4.1" });
    await recordDiscordModelPickerRecentModel({ scope, modelRef: "openai/gpt-4o" });

    const recent = await readDiscordModelPickerRecentModels({ scope });
    expect(recent).toEqual(["openai/gpt-4o", "openai/gpt-4.1"]);
  });

  it("filters recent models using an allowlist", async () => {
    const scope = { userId: "456" };

    await recordDiscordModelPickerRecentModel({ scope, modelRef: "openai/gpt-4o" });
    await recordDiscordModelPickerRecentModel({ scope, modelRef: "openai/gpt-4.1" });

    const recent = await readDiscordModelPickerRecentModels({
      scope,
      allowedModelRefs: new Set(["openai/gpt-4.1"]),
    });
    expect(recent).toEqual(["openai/gpt-4.1"]);
  });

  it("returns empty list for unknown scope", async () => {
    const recent = await readDiscordModelPickerRecentModels({
      scope: { userId: "789" },
    });
    expect(recent).toEqual([]);
  });
});

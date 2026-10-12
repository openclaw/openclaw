import { describe, expect, it } from "vitest";
import { matrixPlugin } from "./channel.js";
import type { CoreConfig } from "./types.js";

describe("matrix message-tool threading", () => {
  it("does not infer a Matrix room thread without an existing thread root", () => {
    expect(
      matrixPlugin.threading!.resolveAutoThreadId!({
        cfg: {} as CoreConfig,
        to: "room:!room:example.org",
        toolContext: { currentChannelId: "room:!room:example.org" },
      }),
    ).toBeUndefined();
  });

  it("does not inherit Matrix room threads from another channel provider", () => {
    const toolContext = {
      currentChannelProvider: "slack" as const,
      currentChannelId: "room:!room:example.org",
      currentThreadTs: "$thread",
    };

    expect(
      matrixPlugin.threading!.matchesToolContextTarget!({
        target: "room:!room:example.org",
        toolContext,
      }),
    ).toBe(false);
    expect(
      matrixPlugin.threading!.resolveAutoThreadId!({
        cfg: {} as CoreConfig,
        to: "room:!room:example.org",
        toolContext,
      }),
    ).toBeUndefined();
  });
});

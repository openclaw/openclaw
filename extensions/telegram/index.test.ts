import { assertBundledChannelEntries } from "openclaw/plugin-sdk/channel-test-helpers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import entry from "./index.js";
import setupEntry from "./setup-entry.js";

describe("telegram bundled entries", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  assertBundledChannelEntries({
    entry,
    expectedId: "telegram",
    expectedName: "Telegram",
    setupEntry,
    channelMessage: "declares the channel entry without importing the broad api barrel",
  });

  it("registers Telegram subagent lifecycle hooks in the full runtime", () => {
    const on = vi.fn();
    entry.register({
      registrationMode: "tool-discovery",
      on,
    } as never);

    expect(on.mock.calls.map((call) => call[0])).toEqual([
      "subagent_spawning",
      "subagent_ended",
      "subagent_delivery_target",
    ]);
  });
});

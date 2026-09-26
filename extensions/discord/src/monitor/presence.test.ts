import { describe, expect, it } from "vitest";
import { resolveDiscordPresenceUpdate } from "./presence.js";

describe("resolveDiscordPresenceUpdate", () => {
  it("returns online presence when no config is provided", () => {
    expect(resolveDiscordPresenceUpdate({})).toEqual({
      status: "online",
      activities: [],
      since: null,
      afk: false,
    });
  });

  it("uses configured status", () => {
    expect(resolveDiscordPresenceUpdate({ status: "dnd" })).toEqual({
      status: "dnd",
      activities: [],
      since: null,
      afk: false,
    });
  });

  it("includes custom activity by default", () => {
    expect(resolveDiscordPresenceUpdate({ activity: "Helping humans" })).toEqual({
      status: "online",
      activities: [{ type: 4, name: "Custom Status", state: "Helping humans" }],
      since: null,
      afk: false,
    });
  });

  it("respects explicit activityType", () => {
    expect(resolveDiscordPresenceUpdate({ activity: "test", activityType: 3 })).toMatchObject({
      activities: [{ type: 3, name: "test" }],
    });
  });

  it("sets streaming URL for type 1", () => {
    expect(
      resolveDiscordPresenceUpdate({
        activity: "Live",
        activityType: 1,
        activityUrl: "https://twitch.tv/test",
      }),
    ).toEqual({
      status: "online",
      activities: [{ type: 1, name: "Live", url: "https://twitch.tv/test" }],
      since: null,
      afk: false,
    });
  });
});

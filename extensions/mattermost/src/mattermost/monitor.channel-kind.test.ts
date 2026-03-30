import { describe, expect, it } from "vitest";
import { mapMattermostChannelTypeToChatType } from "./monitor.js";

describe("mapMattermostChannelTypeToChatType", () => {
  it("maps direct and group dm channel types", () => {
    expect(mapMattermostChannelTypeToChatType("D")).toBe("direct");
    expect(mapMattermostChannelTypeToChatType("g")).toBe("group");
  });

  it("maps private channels to group", () => {
    expect(mapMattermostChannelTypeToChatType("P")).toBe("group");
    expect(mapMattermostChannelTypeToChatType(" p ")).toBe("group");
  });

  it("keeps public channels and unrecognised type strings as channel", () => {
    expect(mapMattermostChannelTypeToChatType("O")).toBe("channel");
    expect(mapMattermostChannelTypeToChatType("x")).toBe("channel");
  });

  it("returns unknown for null and undefined (channel type not resolvable)", () => {
    expect(mapMattermostChannelTypeToChatType(undefined)).toBe("unknown");
    expect(mapMattermostChannelTypeToChatType(null)).toBe("unknown");
  });
});

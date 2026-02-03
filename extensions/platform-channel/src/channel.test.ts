import { describe, expect, it } from "vitest";
import { platformChannelPlugin } from "./channel.js";

describe("platform-channel plugin", () => {
  it("should have correct id", () => {
    expect(platformChannelPlugin.id).toBe("platform-channel");
  });

  it("should have gateway adapter", () => {
    expect(platformChannelPlugin.gateway).toBeDefined();
    expect(platformChannelPlugin.gateway?.startAccount).toBeDefined();
  });

  it("should have outbound adapter", () => {
    expect(platformChannelPlugin.outbound).toBeDefined();
  });
});

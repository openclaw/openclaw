import { describe, expect, it } from "vitest";
import { detectSlackMuteIntent } from "./mute-detection.js";

describe("detectSlackMuteIntent", () => {
  it("matches bare 'mute'", () => {
    expect(detectSlackMuteIntent("mute")).toBe("mute");
    expect(detectSlackMuteIntent("Mute!")).toBe("mute");
    expect(detectSlackMuteIntent("please mute now")).toBe("mute");
  });

  it("matches when the bot is tagged before the command", () => {
    expect(detectSlackMuteIntent("<@U0AHQ49SD38> mute")).toBe("mute");
    expect(detectSlackMuteIntent("<@U0AHQ49SD38|monica> stop responding")).toBe("mute");
  });

  it("matches the documented phrasings", () => {
    expect(detectSlackMuteIntent("Monica, stop responding please")).toBe("mute");
    expect(detectSlackMuteIntent("hey, stop replying for now")).toBe("mute");
    expect(detectSlackMuteIntent("monica stop chiming in")).toBe("mute");
    expect(detectSlackMuteIntent("be quiet for a sec")).toBe("mute");
    expect(detectSlackMuteIntent("stay quiet")).toBe("mute");
    expect(detectSlackMuteIntent("stay silent")).toBe("mute");
    expect(detectSlackMuteIntent("hush")).toBe("mute");
    expect(detectSlackMuteIntent("shush")).toBe("mute");
  });

  it("does not match conjugations that are not commands", () => {
    expect(detectSlackMuteIntent("I muted my mic")).toBeNull();
    expect(detectSlackMuteIntent("muting the alerts")).toBeNull();
  });

  it("does not match bare 'stop'", () => {
    expect(detectSlackMuteIntent("let me stop and think")).toBeNull();
    expect(detectSlackMuteIntent("stop")).toBeNull();
  });

  it("does not match unrelated chatter", () => {
    expect(detectSlackMuteIntent("looks good to me")).toBeNull();
    expect(detectSlackMuteIntent("how's the deploy going")).toBeNull();
    expect(detectSlackMuteIntent("")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(detectSlackMuteIntent("MUTE")).toBe("mute");
    expect(detectSlackMuteIntent("Stop Responding")).toBe("mute");
    expect(detectSlackMuteIntent("BE QUIET")).toBe("mute");
  });
});

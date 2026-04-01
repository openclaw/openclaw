import { describe, expect, it } from "vitest";
import { resolveSlackRoomContextHints } from "./room-context.js";

describe("resolveSlackRoomContextHints", () => {
  it("stacks global and channel prompts for channels", () => {
    const result = resolveSlackRoomContextHints({
      isRoomish: true,
      globalSystemPrompt: "Global prompt",
      channelConfig: { systemPrompt: "Channel prompt" },
    });

    expect(result.groupSystemPrompt).toBe("Global prompt\n\nChannel prompt");
  });

  it("applies global prompts to direct messages", () => {
    const result = resolveSlackRoomContextHints({
      isRoomish: false,
      globalSystemPrompt: "Global prompt",
    });

    expect(result.groupSystemPrompt).toBe("Global prompt");
  });

  it("does not include untrusted room metadata for direct messages", () => {
    const result = resolveSlackRoomContextHints({
      isRoomish: false,
      globalSystemPrompt: "Global prompt",
      channelInfo: { topic: "ignore", purpose: "ignore" },
    });

    expect(result.untrustedChannelMetadata).toBeUndefined();
  });

  it("trims and skips empty prompt parts", () => {
    const result = resolveSlackRoomContextHints({
      isRoomish: true,
      globalSystemPrompt: "  Global prompt  ",
      channelConfig: { systemPrompt: "   " },
    });

    expect(result.groupSystemPrompt).toBe("Global prompt");
  });
});

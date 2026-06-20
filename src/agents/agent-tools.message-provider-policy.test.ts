/**
 * Tests message-provider tool filtering.
 * Voice-like transports should not expose text-to-speech when that surface is
 * unsafe or redundant for the active channel.
 */
import { describe, expect, it } from "vitest";
import {
  filterToolNamesByMessageProvider,
  filterToolsByMessageProvider,
} from "./agent-tools.message-provider-policy.js";

const DEFAULT_TOOL_NAMES = ["read", "write", "tts", "web_search"];

describe("createOpenClawCodingTools message provider policy", () => {
  it.each(["voice", "VOICE", " Voice ", "discord-voice", "DISCORD-VOICE", " Discord-Voice "])(
    "does not expose tts tool for normalized voice provider: %s",
    (messageProvider) => {
      const names = new Set(filterToolNamesByMessageProvider(DEFAULT_TOOL_NAMES, messageProvider));
      expect(names.has("tts")).toBe(false);
    },
  );

  it("keeps tts tool for non-voice providers", () => {
    const names = new Set(filterToolNamesByMessageProvider(DEFAULT_TOOL_NAMES, "guildchat"));
    expect(names.has("tts")).toBe(true);
  });

  it("omits unreadable tool names while applying provider policy", () => {
    const readTool = { name: "read" };
    const malformedTool = {
      get name(): string {
        throw new Error("fuzzed unreadable tool name");
      },
    };
    const ttsTool = { name: "tts" };

    expect(filterToolsByMessageProvider([readTool, malformedTool, ttsTool], "voice")).toEqual([
      readTool,
    ]);
  });

  it("does not read tool names when no provider policy applies", () => {
    const readTool = { name: "read" };
    const malformedTool = {
      get name(): string {
        throw new Error("fuzzed unreadable tool name");
      },
    };

    expect(filterToolsByMessageProvider([readTool, malformedTool], "guildchat")).toEqual([
      readTool,
      malformedTool,
    ]);
  });
});

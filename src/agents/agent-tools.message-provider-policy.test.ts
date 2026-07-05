/**
 * Tests message-provider tool filtering.
 * Voice-like transports should not expose text-to-speech when that surface is
 * unsafe or redundant for the active channel.
 */
import { describe, expect, it } from "vitest";
<<<<<<< HEAD
import { filterToolsByMessageProvider } from "./agent-tools.message-provider-policy.js";

const DEFAULT_TOOLS = [
  { name: "read" },
  { name: "write" },
  { name: "tts" },
  { name: "web_search" },
];

function toolNames(tools: readonly { name: string }[]): Set<string> {
  return new Set(tools.map((tool) => tool.name));
}
=======
import { filterToolNamesByMessageProvider } from "./agent-tools.message-provider-policy.js";

const DEFAULT_TOOL_NAMES = ["read", "write", "tts", "web_search"];
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

describe("createOpenClawCodingTools message provider policy", () => {
  it.each(["voice", "VOICE", " Voice ", "discord-voice", "DISCORD-VOICE", " Discord-Voice "])(
    "does not expose tts tool for normalized voice provider: %s",
    (messageProvider) => {
<<<<<<< HEAD
      const names = toolNames(filterToolsByMessageProvider(DEFAULT_TOOLS, messageProvider));
=======
      const names = new Set(filterToolNamesByMessageProvider(DEFAULT_TOOL_NAMES, messageProvider));
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
      expect(names.has("tts")).toBe(false);
    },
  );

  it("keeps tts tool for non-voice providers", () => {
<<<<<<< HEAD
    const names = toolNames(filterToolsByMessageProvider(DEFAULT_TOOLS, "guildchat"));
    expect(names.has("tts")).toBe(true);
  });

  it("preserves duplicate tool entries while filtering", () => {
    const tools = [
      { name: "read", id: 1 },
      { name: "tts", id: 2 },
      { name: "read", id: 3 },
    ];
    expect(filterToolsByMessageProvider(tools, "voice")).toStrictEqual([
      { name: "read", id: 1 },
      { name: "read", id: 3 },
    ]);
  });
=======
    const names = new Set(filterToolNamesByMessageProvider(DEFAULT_TOOL_NAMES, "guildchat"));
    expect(names.has("tts")).toBe(true);
  });
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
});

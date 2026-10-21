import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_DISCORD_TEST_CONFIG } from "../test-support/config.js";
import { generateThreadTitle } from "./thread-title.js";

const generateConversationLabelMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/reply-dispatch-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/reply-dispatch-runtime")>()),
  generateConversationLabel: generateConversationLabelMock,
}));

function generate(overrides: Partial<Parameters<typeof generateThreadTitle>[0]> = {}) {
  return generateThreadTitle({
    cfg: EMPTY_DISCORD_TEST_CONFIG,
    agentId: "main",
    messageText: "Generate title.",
    ...overrides,
  });
}

beforeEach(() => {
  generateConversationLabelMock.mockReset();
  generateConversationLabelMock.mockResolvedValue("Generated title");
});

describe("generateThreadTitle", () => {
  it.each([
    [' "Weekly Release Summary"\nExtra text', "Weekly Release Summary"],
    ["```markdown\nWeekly Release Summary\n```", "Weekly Release Summary"],
    ["**Scaling ArcherScore Development Roadmap**", "Scaling ArcherScore Development Roadmap"],
    ['"__Weekly Release Summary__"', "Weekly Release Summary"],
    ["*Plan* for *project*", "*Plan* for *project*"],
    ["***Release plan***", "Release plan"],
  ])("normalizes generated title %j", async (generated, expected) => {
    generateConversationLabelMock.mockResolvedValueOnce(generated);
    await expect(generate()).resolves.toBe(expected);
  });

  it("routes through the shared isolated label generator", async () => {
    await generate({
      modelRef: "openai/gpt-4.1-mini@local",
      messageText: "Summarize deployment blockers and owner follow-ups.",
      channelName: "release-status",
      channelDescription: "Deploy updates and incident notes",
    });

    expect(generateConversationLabelMock).toHaveBeenCalledWith({
      cfg: EMPTY_DISCORD_TEST_CONFIG,
      agentId: "main",
      userMessage:
        "Channel: release-status\n\nChannel description: Deploy updates and incident notes\n\nMessage:\nSummarize deployment blockers and owner follow-ups.",
      prompt:
        "Generate a concise Discord thread title (3-6 words) in sentence case: capitalize only the first word and words that are always capitalized. Return only the title. Use channel context when provided and avoid redundant channel-name words unless needed for clarity.",
      modelRef: "openai/gpt-4.1-mini@local",
      timeoutMs: 60_000,
      maxLength: 600,
    });
  });

  it("keeps truncated prompt fields on UTF-16 boundaries", async () => {
    await generate({
      messageText: `${"m".repeat(599)}😀tail`,
      channelName: `${"n".repeat(119)}😀tail`,
      channelDescription: `${"d".repeat(319)}😀tail`,
    });

    const content = generateConversationLabelMock.mock.calls[0]?.[0]?.userMessage ?? "";
    expect(content).toBe(
      `Channel: ${"n".repeat(119)}...\n\nChannel description: ${"d".repeat(319)}...\n\nMessage:\n${"m".repeat(599)}...`,
    );
  });

  it("returns null for empty input, empty output, or generation failure", async () => {
    await expect(generate({ messageText: " " })).resolves.toBeNull();
    generateConversationLabelMock.mockResolvedValueOnce(null);
    await expect(generate()).resolves.toBeNull();
    generateConversationLabelMock.mockRejectedValueOnce(new Error("network timeout"));
    await expect(generate()).resolves.toBeNull();
  });
});

// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatMessage } from "./chat-message";

vi.mock("next/dynamic", () => ({
  default: () => () => null,
}));

vi.mock("posthog-js", () => ({
  default: {
    get_distinct_id: vi.fn(() => "distinct-id"),
  },
}));

vi.mock("posthog-js/react/surveys", () => ({
  useThumbSurvey: vi.fn(() => ({
    respond: vi.fn(),
    response: null,
    triggerRef: { current: null },
  })),
}));

describe("ChatMessage", () => {
  it("shows the speaker action for completed assistant text when voice playback is enabled", () => {
    render(
      <ChatMessage
        message={{
          id: "assistant-1",
          role: "assistant",
          parts: [{ type: "text", text: "Hello from Dench." }],
        }}
        voicePlaybackEnabled
      />,
    );

    expect(screen.getByRole("button", { name: "Play voice" })).toBeInTheDocument();
  });

  it("hides the speaker action while the assistant message is still streaming", () => {
    render(
      <ChatMessage
        message={{
          id: "assistant-2",
          role: "assistant",
          parts: [{ type: "text", text: "Still thinking..." }],
        }}
        isStreaming
        voicePlaybackEnabled
      />,
    );

    expect(screen.queryByRole("button", { name: "Play voice" })).not.toBeInTheDocument();
  });
});

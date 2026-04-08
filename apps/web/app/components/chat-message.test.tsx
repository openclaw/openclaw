// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatMessage } from "./chat-message";
import { buildComposioChatActionHref } from "@/lib/composio-chat-actions";

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

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it("copies assistant turns from the inline copy action", async () => {
    const user = userEvent.setup();
    const writeTextSpy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();

    render(
      <ChatMessage
        message={{
          id: "assistant-copy",
          role: "assistant",
          parts: [{ type: "text", text: "Hello from Dench." }],
        }}
        copyable
      />,
    );

    await user.click(screen.getByRole("button", { name: "Copy message" }));

    expect(writeTextSpy).toHaveBeenCalledWith("Hello from Dench.");
  });

  it("copies user turns with attachment metadata", async () => {
    const user = userEvent.setup();
    const writeTextSpy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();

    render(
      <ChatMessage
        message={{
          id: "user-copy",
          role: "user",
          parts: [{
            type: "text",
            text: "[Attached files: /tmp/alpha.ts, /tmp/beta.ts] Please compare these files.",
          }],
        }}
        copyable
      />,
    );

    await user.click(screen.getByRole("button", { name: "Copy message" }));

    expect(writeTextSpy).toHaveBeenCalledWith(
      "Please compare these files.\n\nAttached files:\n/tmp/alpha.ts\n/tmp/beta.ts",
    );
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

  it("intercepts assistant composio action links inline", async () => {
    const user = userEvent.setup();
    const onComposioAction = vi.fn();

    render(
      <ChatMessage
        message={{
          id: "assistant-3",
          role: "assistant",
          parts: [{
            type: "text",
            text: `Slack is not connected yet. [Connect Slack](${buildComposioChatActionHref("connect", { toolkitSlug: "slack", toolkitName: "Slack" })})`,
          }],
        }}
        onComposioAction={onComposioAction}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Connect Slack" }));

    expect(onComposioAction).toHaveBeenCalledWith({
      action: "connect",
      toolkitSlug: "slack",
      toolkitName: "Slack",
    });
  });

  it("renders the branded Stripe connect action", () => {
    render(
      <ChatMessage
        message={{
          id: "assistant-4",
          role: "assistant",
          parts: [{
            type: "text",
            text: `Stripe needs attention. [Connect Stripe](${buildComposioChatActionHref("connect", { toolkitSlug: "stripe", toolkitName: "Stripe" })})`,
          }],
        }}
      />,
    );

    const button = screen.getByRole("button", { name: "Connect Stripe" });
    const logo = button.querySelector('img[src="/integrations/stripe-logomark.svg"]');

    expect(logo).toBeTruthy();
  });
});

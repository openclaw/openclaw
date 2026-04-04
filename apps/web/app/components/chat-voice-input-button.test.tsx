// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatVoiceInputButton } from "./chat-voice-input-button";

class FakeSpeechRecognition {
  continuous = false;
  interimResults = false;
  maxAlternatives = 1;
  lang?: string;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null = null;
  start = vi.fn();
  stop = vi.fn(() => {
    this.onend?.();
  });
}

describe("ChatVoiceInputButton", () => {
  let lastRecognition: FakeSpeechRecognition | null = null;

  beforeEach(() => {
    lastRecognition = null;
    vi.restoreAllMocks();
    Object.defineProperty(window, "webkitSpeechRecognition", {
      configurable: true,
      writable: true,
      value: class extends FakeSpeechRecognition {
        constructor() {
          super();
          lastRecognition = this;
        }
      },
    });
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(window, "MediaRecorder", {
      configurable: true,
      writable: true,
      value: undefined,
    });
  });

  it("falls back to browser speech recognition when server transcription cannot be used", async () => {
    const onTranscript = vi.fn();

    render(
      <ChatVoiceInputButton
        preferServerTranscription
        onTranscript={onTranscript}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start voice input" }));

    expect(lastRecognition?.start).toHaveBeenCalledTimes(1);

    lastRecognition?.onresult?.({
      results: [[{ transcript: "voice from browser" }]],
    });
    lastRecognition?.onend?.();

    await waitFor(() => {
      expect(onTranscript).toHaveBeenCalledWith("voice from browser");
    });
  });
});

"use client";

import { useEffect, useRef, useState } from "react";

type PlaybackState = "idle" | "loading" | "playing" | "error";

function SpeakerIcon({ state }: { state: PlaybackState }) {
  if (state === "loading") {
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="animate-spin"
      >
        <path d="M21 12a9 9 0 1 1-9-9" />
      </svg>
    );
  }

  if (state === "playing") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <rect x="6" y="5" width="4" height="14" rx="1" />
        <rect x="14" y="5" width="4" height="14" rx="1" />
      </svg>
    );
  }

  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M19 5a10 10 0 0 1 0 14" />
    </svg>
  );
}

export function MessageVoiceButton({ text }: { text: string }) {
  const [state, setState] = useState<PlaybackState>("idle");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    return () => {
      audioRef.current?.pause();
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
    };
  }, []);

  const stopPlayback = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setState("idle");
  };

  const handleClick = async () => {
    if (state === "loading") {
      return;
    }
    if (state === "playing") {
      stopPlayback();
      return;
    }

    setState("loading");
    try {
      const response = await fetch("/api/voice/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) {
        throw new Error("Failed to generate audio.");
      }

      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      objectUrlRef.current = objectUrl;
      const audio = new Audio(objectUrl);
      audioRef.current = audio;
      audio.addEventListener("ended", stopPlayback, { once: true });
      await audio.play();
      setState("playing");
    } catch {
      setState("error");
      window.setTimeout(() => setState("idle"), 2000);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      className="p-1 rounded-md transition-colors"
      style={{
        color: state === "error" ? "var(--color-error, #ef4444)" : "var(--color-text-muted)",
      }}
      title={state === "playing" ? "Stop voice playback" : "Play voice"}
      aria-label={state === "playing" ? "Stop voice playback" : "Play voice"}
    >
      <SpeakerIcon state={state} />
    </button>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type VoiceInputState = "idle" | "recording" | "listening" | "processing" | "error";

type BrowserSpeechRecognitionEvent = Event & {
  results: ArrayLike<ArrayLike<{ transcript: string }>>;
};

type BrowserSpeechRecognition = {
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  lang?: string;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  onresult: ((event: BrowserSpeechRecognitionEvent) => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionConstructor = new () => BrowserSpeechRecognition;

function MicIcon({ state }: { state: VoiceInputState }) {
  if (state === "processing") {
    return (
      <svg
        width="16"
        height="16"
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

  if (state === "recording" || state === "listening") {
    return (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <rect x="7" y="7" width="10" height="10" rx="2" />
      </svg>
    );
  }

  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 1 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <path d="M12 19v3" />
    </svg>
  );
}

export function ChatVoiceInputButton({
  compact,
  disabled = false,
  preferServerTranscription,
  onTranscript,
}: {
  compact?: boolean;
  disabled?: boolean;
  preferServerTranscription: boolean;
  onTranscript: (text: string) => void;
}) {
  const [state, setState] = useState<VoiceInputState>("idle");
  const [browserSpeechSupported, setBrowserSpeechSupported] = useState(false);
  const [recordingSupported, setRecordingSupported] = useState(false);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recognitionRef = useRef<BrowserSpeechRecognition | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const recognitionWindow = window as Window & typeof globalThis & {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };

    setBrowserSpeechSupported(
      Boolean(recognitionWindow.SpeechRecognition || recognitionWindow.webkitSpeechRecognition),
    );
    setRecordingSupported(
      typeof navigator !== "undefined"
      && Boolean(navigator.mediaDevices?.getUserMedia)
      && typeof MediaRecorder !== "undefined",
    );
  }, []);

  useEffect(() => {
    return () => {
      recognitionRef.current?.stop();
      recorderRef.current?.stop();
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  const inputMode = useMemo(() => {
    if (preferServerTranscription && recordingSupported) {
      return "server";
    }
    if (browserSpeechSupported) {
      return "browser";
    }
    return "unsupported";
  }, [browserSpeechSupported, preferServerTranscription, recordingSupported]);

  const startBrowserRecognition = async () => {
    if (typeof window === "undefined") {
      return;
    }

    const recognitionWindow = window as Window & typeof globalThis & {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };
    const RecognitionCtor = recognitionWindow.SpeechRecognition || recognitionWindow.webkitSpeechRecognition;
    if (!RecognitionCtor) {
      setState("error");
      window.setTimeout(() => setState("idle"), 1500);
      return;
    }

    const recognition = new RecognitionCtor();
    recognitionRef.current = recognition;
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0]?.transcript ?? "")
        .join(" ")
        .trim();
      if (transcript) {
        onTranscript(transcript);
      }
    };
    recognition.onerror = () => {
      setState("idle");
      recognitionRef.current = null;
    };
    recognition.onend = () => {
      setState("idle");
      recognitionRef.current = null;
    };
    recognition.start();
    setState("listening");
  };

  const stopBrowserRecognition = () => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setState("idle");
  };

  const startServerRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const chunks: Blob[] = [];
      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunks.push(event.data);
        }
      };

      recorder.onstop = async () => {
        try {
          setState("processing");
          const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
          const formData = new FormData();
          formData.set(
            "file",
            new File([blob], "voice-input.webm", { type: blob.type || "audio/webm" }),
          );

          const response = await fetch("/api/voice/transcribe", {
            method: "POST",
            body: formData,
          });
          if (!response.ok) {
            throw new Error("Failed to transcribe audio.");
          }
          const payload = await response.json() as { text?: string };
          if (payload.text?.trim()) {
            onTranscript(payload.text.trim());
          }
          setState("idle");
        } catch {
          setState("error");
          window.setTimeout(() => setState("idle"), 1500);
        } finally {
          recorderRef.current = null;
          streamRef.current?.getTracks().forEach((track) => track.stop());
          streamRef.current = null;
        }
      };

      recorder.start();
      setState("recording");
    } catch {
      if (browserSpeechSupported) {
        await startBrowserRecognition();
        return;
      }
      setState("error");
      window.setTimeout(() => setState("idle"), 1500);
    }
  };

  const stopServerRecording = () => {
    recorderRef.current?.stop();
  };

  const handleClick = async () => {
    if (disabled || state === "processing" || inputMode === "unsupported") {
      return;
    }

    if (inputMode === "server") {
      if (state === "recording") {
        stopServerRecording();
        return;
      }
      await startServerRecording();
      return;
    }

    if (state === "listening") {
      stopBrowserRecognition();
      return;
    }
    await startBrowserRecognition();
  };

  const title = inputMode === "unsupported"
    ? "Voice input is not supported in this browser"
    : state === "processing"
      ? "Transcribing..."
      : state === "recording" || state === "listening"
        ? "Stop voice input"
        : "Start voice input";

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      disabled={disabled || inputMode === "unsupported"}
      className="p-1.5 rounded-lg transition-opacity disabled:cursor-not-allowed disabled:opacity-40"
      style={{
        color: state === "error"
          ? "var(--color-error, #ef4444)"
          : state === "recording" || state === "listening"
            ? "var(--color-accent)"
            : "var(--color-text-muted)",
      }}
      title={title}
      aria-label={title}
      data-compact={compact ? "true" : "false"}
    >
      <MicIcon state={state} />
    </button>
  );
}

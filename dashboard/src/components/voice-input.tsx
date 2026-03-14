"use client";

import { useState, useRef, useCallback } from "react";
import { Mic, MicOff } from "lucide-react";
import { cn } from "@/lib/utils";

interface VoiceInputProps {
  onResult: (text: string) => void;
  className?: string;
}

export function VoiceInput({ onResult, className }: VoiceInputProps) {
  const [isListening, setIsListening] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);

  const toggle = useCallback(() => {
    if (isListening) {
      recognitionRef.current?.stop();
      setIsListening(false);
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SR) return;

    const recognition = new SR();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";

    recognition.onresult = (event: { results: { 0: { 0: { transcript: string } } } }) => {
      const text = event.results[0]?.[0]?.transcript;
      if (text) onResult(text);
      setIsListening(false);
    };

    recognition.onerror = () => setIsListening(false);
    recognition.onend = () => setIsListening(false);

    recognitionRef.current = recognition;
    recognition.start();
    setIsListening(true);
  }, [isListening, onResult]);

  return (
    <button
      onClick={toggle}
      className={cn(
        "p-2 rounded-lg transition-colors",
        isListening
          ? "bg-red-500/20 text-red-400"
          : "text-muted-foreground hover:text-foreground hover:bg-white/[0.06]",
        className
      )}
      title={isListening ? "Stop listening" : "Voice input"}
    >
      {isListening ? (
        <MicOff className="w-3.5 h-3.5 animate-pulse" />
      ) : (
        <Mic className="w-3.5 h-3.5" />
      )}
    </button>
  );
}

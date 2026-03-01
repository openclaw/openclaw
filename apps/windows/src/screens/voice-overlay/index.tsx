import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Button, Text, tokens } from "@fluentui/react-components";
import { playVoiceChime } from "../../utils/voiceChime";
import {
  VoiceAudioLevelPayload,
  VoiceOverlayDismissPayload,
  VoicePttStatePayload,
  VoiceWakeActivePayload,
  VoiceWakeTriggeredPayload,
} from "./types";

export function VoiceOverlay() {
  const [transcript, setTranscript] = useState("");
  const [draftTranscript, setDraftTranscript] = useState("");
  const [isActive, setIsActive] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [isAnimating, setIsAnimating] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isHovering, setIsHovering] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const activeTokenRef = useRef<string | null>(null);
  const activeLocalRef = useRef(false);

  const getAudioContext = useCallback(() => {
    if (!audioCtxRef.current) {
      const win = window as Window & {
        webkitAudioContext?: typeof AudioContext;
      };
      const AudioContextCtor = window.AudioContext ?? win.webkitAudioContext;
      if (!AudioContextCtor) {
        throw new Error("AudioContext API is not available");
      }
      audioCtxRef.current = new AudioContextCtor();
    }
    return audioCtxRef.current;
  }, []);

  const playChime = useCallback(
    (chime: string, type: "invoke" | "send") => {
      try {
        const audioCtx = getAudioContext();
        void playVoiceChime(chime, type, audioCtx).catch((error) => {
          console.error("Failed to play chime", error);
        });
      } catch (e) {
        console.error("Failed to play chime", e);
      }
    },
    [getAudioContext]
  );

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current != null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const hideOverlayNow = useCallback(() => {
    clearHideTimer();
    setIsSending(false);
    setIsAnimating(false);
    setIsEditing(false);
    setIsActive(false);
    setIsHovering(false);
    activeLocalRef.current = false;
    activeTokenRef.current = null;
    setTranscript("");
    setDraftTranscript("");
    setAudioLevel(0);
    void getCurrentWindow().hide();
  }, [clearHideTimer]);

  const hideOverlay = useCallback(
    (delayMs: number) => {
      clearHideTimer();
      hideTimerRef.current = window.setTimeout(() => {
        hideOverlayNow();
      }, delayMs);
    },
    [clearHideTimer, hideOverlayNow]
  );

  const sendNow = useCallback(async () => {
    const finalText = draftTranscript.trim();
    if (!finalText || isSending) {
      return;
    }

    try {
      setIsSending(true);
      setIsEditing(false);
      setTranscript(finalText);
      await invoke("voice_overlay_send", {
        token: activeTokenRef.current,
        transcript: finalText,
      });
      hideOverlay(280);
    } catch (error) {
      console.error("Failed to send voice overlay transcript", error);
      setIsSending(false);
    }
  }, [draftTranscript, hideOverlay, isSending]);

  useEffect(() => {
    const unlistenPtt = listen<VoicePttStatePayload>(
      "voice_ptt_state",
      ({ payload }) => {
        const active = payload?.active ?? false;
        const keepVisible = payload?.keepVisible ?? false;
        const token = payload?.token ?? null;
        if (active) {
          clearHideTimer();
          activeLocalRef.current = true;
          if (token) activeTokenRef.current = token;
          setIsActive(true);
          setIsSending(false);
          setIsAnimating(true);
          setIsEditing(false);
          if (payload?.error) {
            setTranscript(payload.error);
            setDraftTranscript(payload.error);
          } else {
            setTranscript("Listening...");
            setDraftTranscript("Listening...");
          }
          void getCurrentWindow().show();
          return;
        }

        if (keepVisible) {
          if (
            token &&
            activeTokenRef.current &&
            token !== activeTokenRef.current
          ) {
            return;
          }
          if (token) activeTokenRef.current = token;
          setIsSending(true);
          setIsEditing(false);
          setTranscript("Sending...");
          setDraftTranscript("Sending...");
          setIsAnimating(true);
          setIsActive(true);
          void getCurrentWindow().show();
          return;
        }

        hideOverlay(160);
      }
    );

    const unlistenActive = listen<VoiceWakeActivePayload>(
      "voice_wake_active",
      ({ payload }) => {
        clearHideTimer();
        const token = payload?.token ?? null;
        if (
          token &&
          activeTokenRef.current &&
          token !== activeTokenRef.current
        ) {
          return;
        }
        if (token) activeTokenRef.current = token;
        if (!activeLocalRef.current) {
          playChime(payload?.triggerChime ?? "Glass", "invoke");
          activeLocalRef.current = true;
          setIsAnimating(true);
        }

        const nextTranscript = payload?.transcript ?? "";
        setTranscript(nextTranscript);
        if (!isEditing) {
          setDraftTranscript(nextTranscript);
        }
        setIsActive(true);
        setIsSending(false);

        void getCurrentWindow().show();
      }
    );

    const unlistenTrigger = listen<VoiceWakeTriggeredPayload>(
      "voice_wake_triggered",
      ({ payload }) => {
        clearHideTimer();
        const token = payload?.token ?? null;
        if (
          token &&
          activeTokenRef.current &&
          token !== activeTokenRef.current
        ) {
          return;
        }
        if (token) activeTokenRef.current = token;
        setIsSending(true);
        setIsEditing(false);
        playChime(payload?.sendChime ?? "Glass", "send");
        const delayMs = token?.startsWith("ptt-") ? 12000 : 280;
        hideOverlay(delayMs);
      }
    );

    const unlistenDismissed = listen<VoiceOverlayDismissPayload>(
      "voice_overlay_session_dismissed",
      ({ payload }) => {
        const token = payload?.token ?? null;
        if (
          token &&
          activeTokenRef.current &&
          token !== activeTokenRef.current
        ) {
          return;
        }
        hideOverlay(120);
      }
    );

    const unlistenAudioLevel = listen<VoiceAudioLevelPayload>(
      "voice_audio_level",
      ({ payload }) => {
        const level = payload?.level ?? 0;
        setAudioLevel((prev) => prev * 0.3 + level * 0.7);
      }
    );

    return () => {
      unlistenPtt.then((f) => f());
      unlistenActive.then((f) => f());
      unlistenTrigger.then((f) => f());
      unlistenDismissed.then((f) => f());
      unlistenAudioLevel.then((f) => f());
      clearHideTimer();
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(console.error);
        audioCtxRef.current = null;
      }
    };
  }, [clearHideTimer, hideOverlay, isEditing, playChime]);

  if (!isActive) return null;

  const barCount = 5;
  const bars = Array.from({ length: barCount }).map((_, i) => {
    const offset = Math.abs(i - Math.floor(barCount / 2));
    const height = 4 + audioLevel * 40 * (1 - offset * 0.2);
    return Math.max(4, height);
  });

  return (
    <div
      style={{
        width: "100%",
        height: "auto",
        minHeight: "48px",
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-start",
        gap: "10px",
        padding: "8px 12px",
        backgroundColor: tokens.colorNeutralBackground1,
        backdropFilter: "blur(20px)",
        color: tokens.colorNeutralForeground1,
        fontFamily:
          "'Segoe UI Variable Text', 'Segoe UI', system-ui, sans-serif",
        boxSizing: "border-box",
        overflow: "hidden",
        opacity: isAnimating ? 1 : 0,
        transform: isAnimating
          ? "translateY(0) scale(1)"
          : "translateY(15px) scale(0.98)",
        transition:
          "opacity 0.25s ease-out, transform 0.25s cubic-bezier(0.175, 0.885, 0.32, 1.275)",
      }}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
    >
      <div
        data-tauri-drag-region
        style={{
          display: "flex",
          alignItems: "center",
          gap: "3px",
          width: "28px",
          height: "32px",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {bars.map((h, i) => (
          <div
            key={i}
            style={{
              width: "3px",
              height: `${h}px`,
              backgroundColor: isSending
                ? tokens.colorPaletteGreenForeground1
                : tokens.colorBrandForeground1,
              borderRadius: "2px",
              transition: "height 0.1s ease-out",
            }}
          />
        ))}
      </div>

      <div
        style={{
          flex: 1,
          minWidth: 0,
          display: "flex",
          alignItems: "center",
        }}
        onDoubleClick={() => {
          if (!isSending) setIsEditing(true);
        }}
      >
        {isEditing ? (
          <textarea
            value={draftTranscript}
            onChange={(event) => setDraftTranscript(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setIsEditing(false);
                setDraftTranscript(transcript);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void sendNow();
              }
            }}
            style={{
              width: "100%",
              height: "56px",
              resize: "none",
              border: `1px solid ${tokens.colorNeutralStroke1}`,
              borderRadius: "8px",
              padding: "6px 8px",
              background: tokens.colorNeutralBackground2,
              color: tokens.colorNeutralForeground1,
              fontFamily: "inherit",
              fontSize: "13px",
              lineHeight: "18px",
              outline: "none",
            }}
            autoFocus
          />
        ) : (
          <Text
            data-tauri-drag-region
            style={{
              flex: 1,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              fontSize: "13px",
              fontWeight: 500,
              letterSpacing: "-0.01em",
              cursor: isSending ? "default" : "text",
            }}
            title="Double-click to edit"
          >
            {transcript || "Listening..."}
          </Text>
        )}
      </div>

      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          opacity: isHovering || isEditing || isSending ? 1 : 0.75,
          transition: "opacity 0.12s ease-out",
        }}
      >
        <Button
          appearance={isSending ? "secondary" : "primary"}
          size="small"
          disabled={isSending || draftTranscript.trim().length === 0}
          onClick={() => void sendNow()}
        >
          {isSending ? "..." : "Send"}
        </Button>
      </div>
    </div>
  );
}

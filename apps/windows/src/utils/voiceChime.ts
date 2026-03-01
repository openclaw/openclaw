import { convertFileSrc } from "@tauri-apps/api/core";

const CUSTOM_CHIME_PREFIX = "Custom:";

export type VoiceChimeMode = "invoke" | "send";

function fileNameFromPath(value: string): string {
  const parts = value.split(/[/\\]/);
  const name = parts[parts.length - 1]?.trim();
  return name || value;
}

export function isCustomChime(value: string): boolean {
  return value.startsWith(CUSTOM_CHIME_PREFIX);
}

export function customChimePath(value: string): string | null {
  if (!isCustomChime(value)) return null;
  const path = value.slice(CUSTOM_CHIME_PREFIX.length).trim();
  return path.length > 0 ? path : null;
}

export function makeCustomChimeValue(path: string): string {
  return `${CUSTOM_CHIME_PREFIX}${path.trim()}`;
}

export function voiceChimeLabel(value: string): string {
  if (value === "None") return "No Sound";
  const path = customChimePath(value);
  if (!path) return value;
  return fileNameFromPath(path);
}

export async function playVoiceChime(
  value: string,
  mode: VoiceChimeMode,
  audioContext?: AudioContext
): Promise<void> {
  if (value === "None") return;

  const customPath = customChimePath(value);
  if (customPath) {
    const src = convertFileSrc(customPath);
    const audio = new Audio(src);
    audio.preload = "auto";
    audio.volume = 1;
    await audio.play();
    return;
  }

  const AudioContextCtor =
    window.AudioContext ||
    (window as Window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioContextCtor) return;

  const ownsContext = !audioContext;
  const ctx = audioContext ?? new AudioContextCtor();
  if (ctx.state === "suspended") {
    await ctx.resume();
  }

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.connect(gain);
  gain.connect(ctx.destination);

  if (value === "Glass") {
    osc.type = "sine";
    if (mode === "invoke") {
      osc.frequency.setValueAtTime(660, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.1);
    } else {
      osc.frequency.setValueAtTime(1320, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.1);
    }
  } else {
    osc.type = "triangle";
    if (mode === "invoke") {
      osc.frequency.setValueAtTime(440, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.1);
    } else {
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.1);
    }
  }

  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(0.25, ctx.currentTime + 0.05);
  gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
  osc.start();
  osc.stop(ctx.currentTime + 0.35);

  if (ownsContext) {
    window.setTimeout(() => {
      void ctx.close();
    }, 450);
  }
}

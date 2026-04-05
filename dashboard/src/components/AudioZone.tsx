import { useState } from "react";
import type { AudioZoneState } from "../types";
import { sendCommand } from "../api";

type Props = {
  audio: AudioZoneState;
  onOptimisticUpdate: (updates: Partial<AudioZoneState>) => void;
};

export function AudioZone({ audio, onOptimisticUpdate }: Props) {
  const [sliderVolume, setSliderVolume] = useState<number | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  const sendAudio = async (command: string, params?: Record<string, string>) => {
    setPending(command);
    try {
      await sendCommand(audio.roomId, command, params);
    } catch (err) {
      console.error("audio command error:", err);
    } finally {
      setPending(null);
    }
  };

  const handleSourceChange = async (sourceId: string) => {
    onOptimisticUpdate({ currentSourceId: Number(sourceId) });
    await sendAudio("SELECT_AUDIO_DEVICE", { deviceid: sourceId });
  };

  const displayVolume = sliderVolume ?? audio.currentVolume ?? 0;

  return (
    <div className="space-y-3">
      <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">Audio</span>

      {/* Source selector */}
      <select
        value={audio.currentSourceId ?? ""}
        onChange={(e) => handleSourceChange(e.target.value)}
        className="w-full bg-gray-700 text-white text-sm rounded px-2 py-1.5 border border-gray-600 focus:outline-none focus:border-blue-500"
      >
        <option value="" disabled>
          — Select source —
        </option>
        {audio.sources.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>

      {/* Transport buttons */}
      <div className="flex items-center justify-center gap-2">
        <button
          onClick={() => sendAudio("SKIP REV")}
          disabled={pending !== null}
          className="p-2 rounded bg-gray-700 hover:bg-gray-600 text-white text-lg disabled:opacity-50"
          title="Previous"
        >
          ⏮
        </button>
        <button
          onClick={() => sendAudio("PLAY")}
          disabled={pending !== null}
          className="p-2 rounded bg-gray-700 hover:bg-gray-600 text-white text-lg disabled:opacity-50"
          title="Play"
        >
          ▶
        </button>
        <button
          onClick={() => sendAudio("PAUSE")}
          disabled={pending !== null}
          className="p-2 rounded bg-gray-700 hover:bg-gray-600 text-white text-lg disabled:opacity-50"
          title="Pause"
        >
          ⏸
        </button>
        <button
          onClick={() => sendAudio("SKIP FWD")}
          disabled={pending !== null}
          className="p-2 rounded bg-gray-700 hover:bg-gray-600 text-white text-lg disabled:opacity-50"
          title="Next"
        >
          ⏭
        </button>
        <button
          onClick={() => sendAudio("DISCONNECT")}
          disabled={pending !== null}
          className="p-2 rounded bg-gray-700 hover:bg-red-900/50 text-gray-400 hover:text-red-400 text-lg disabled:opacity-50"
          title="Power off"
        >
          ⏻
        </button>
      </div>

      {/* Volume slider */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-gray-500 w-4">🔈</span>
        <input
          type="range"
          min={0}
          max={100}
          value={displayVolume}
          onChange={(e) => {
            const val = Number(e.target.value);
            setSliderVolume(val);
            onOptimisticUpdate({ currentVolume: val });
          }}
          onPointerUp={(e) => {
            const val = Number((e.target as HTMLInputElement).value);
            setSliderVolume(null);
            sendAudio("SET_VOLUME_LEVEL", { LEVEL: String(val) });
          }}
          className="flex-1 h-1.5 bg-gray-700 rounded-full appearance-none cursor-pointer accent-blue-400"
        />
        <span className="text-xs text-gray-500 w-8 text-right">{displayVolume}%</span>
      </div>
    </div>
  );
}

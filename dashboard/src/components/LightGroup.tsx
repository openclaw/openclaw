import { useState, useCallback } from "react";
import type { LightState } from "../types";
import { sendCommand } from "../api";

type Props = {
  lights: LightState[];
  onOptimisticUpdate: (id: number, updates: Partial<LightState>) => void;
};

export function LightGroup({ lights, onOptimisticUpdate }: Props) {
  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set());
  const [sliderValues, setSliderValues] = useState<Map<number, number>>(new Map());

  const setPending = (id: number, val: boolean) => {
    setPendingIds((prev) => {
      const next = new Set(prev);
      val ? next.add(id) : next.delete(id);
      return next;
    });
  };

  const toggleLight = useCallback(
    async (light: LightState) => {
      const newOn = !light.on;
      onOptimisticUpdate(light.id, { on: newOn, level: newOn ? 100 : 0 });
      setPending(light.id, true);
      try {
        await sendCommand(light.id, newOn ? "ON" : "OFF");
      } catch (err) {
        console.error("toggle light error:", err);
        // Revert optimistic update
        onOptimisticUpdate(light.id, { on: light.on, level: light.level });
      } finally {
        setPending(light.id, false);
      }
    },
    [onOptimisticUpdate],
  );

  const handleSliderChange = useCallback((id: number, val: number) => {
    setSliderValues((prev) => new Map(prev).set(id, val));
    onOptimisticUpdate(id, { level: val, on: val > 0 });
  }, [onOptimisticUpdate]);

  const handleSliderRelease = useCallback(
    async (light: LightState, val: number) => {
      setPending(light.id, true);
      try {
        await sendCommand(light.id, "RAMP_TO_LEVEL", { LEVEL: String(val) });
      } catch (err) {
        console.error("dim light error:", err);
        // Revert
        onOptimisticUpdate(light.id, { level: light.level, on: light.on });
      } finally {
        setPending(light.id, false);
        setSliderValues((prev) => {
          const next = new Map(prev);
          next.delete(light.id);
          return next;
        });
      }
    },
    [onOptimisticUpdate],
  );

  const allOn = lights.every((l) => l.on);
  const handleGroupToggle = useCallback(async () => {
    const command = allOn ? "OFF" : "ON";
    for (const l of lights) {
      onOptimisticUpdate(l.id, { on: !allOn, level: allOn ? 0 : 100 });
    }
    await Promise.allSettled(lights.map((l) => sendCommand(l.id, command)));
  }, [allOn, lights, onOptimisticUpdate]);

  if (lights.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">Lights</span>
        <button
          onClick={handleGroupToggle}
          className={`text-xs px-2 py-0.5 rounded ${
            allOn
              ? "bg-yellow-500/20 text-yellow-300 hover:bg-yellow-500/30"
              : "bg-gray-700 text-gray-300 hover:bg-gray-600"
          }`}
        >
          {allOn ? "All off" : "All on"}
        </button>
      </div>

      {lights.map((light) => {
        const displayLevel = sliderValues.get(light.id) ?? light.level;
        const isPending = pendingIds.has(light.id);

        return (
          <div key={light.id} className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-gray-200 truncate flex-1 min-w-0">{light.name}</span>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-gray-500 w-8 text-right">{displayLevel}%</span>
                <button
                  onClick={() => toggleLight(light)}
                  disabled={isPending}
                  className={`relative w-9 h-5 rounded-full transition-colors ${
                    light.on ? "bg-yellow-400" : "bg-gray-600"
                  } ${isPending ? "opacity-50" : ""}`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                      light.on ? "translate-x-4" : "translate-x-0"
                    }`}
                  />
                </button>
              </div>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={displayLevel}
              onChange={(e) => handleSliderChange(light.id, Number(e.target.value))}
              onPointerUp={(e) => handleSliderRelease(light, Number((e.target as HTMLInputElement).value))}
              className="w-full h-1.5 bg-gray-700 rounded-full appearance-none cursor-pointer accent-yellow-400"
            />
          </div>
        );
      })}
    </div>
  );
}

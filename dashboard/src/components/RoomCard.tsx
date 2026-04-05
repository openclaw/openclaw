import { useState, useCallback } from "react";
import type { RoomState, LightState, ThermostatState, AudioZoneState, LockState } from "../types";
import { LightGroup } from "./LightGroup";
import { ThermostatCard } from "./ThermostatCard";
import { AudioZone } from "./AudioZone";
import { LockControl } from "./LockControl";

type Props = {
  room: RoomState;
  onUpdate: (updated: RoomState) => void;
};

export function RoomCard({ room, onUpdate }: Props) {
  const [localRoom, setLocalRoom] = useState<RoomState>(room);

  // Sync from parent (SSE patches)
  if (JSON.stringify(room) !== JSON.stringify(localRoom)) {
    setLocalRoom(room);
  }

  const updateLight = useCallback((id: number, updates: Partial<LightState>) => {
    setLocalRoom((prev) => {
      const updated = {
        ...prev,
        lights: prev.lights.map((l) => (l.id === id ? { ...l, ...updates } : l)),
      };
      onUpdate(updated);
      return updated;
    });
  }, [onUpdate]);

  const updateThermostat = useCallback((id: number, updates: Partial<ThermostatState>) => {
    setLocalRoom((prev) => {
      const updated = {
        ...prev,
        thermostats: prev.thermostats.map((t) => (t.id === id ? { ...t, ...updates } : t)),
      };
      onUpdate(updated);
      return updated;
    });
  }, [onUpdate]);

  const updateAudio = useCallback((updates: Partial<AudioZoneState>) => {
    setLocalRoom((prev) => {
      const updated = {
        ...prev,
        audio: prev.audio ? { ...prev.audio, ...updates } : prev.audio,
      };
      onUpdate(updated);
      return updated;
    });
  }, [onUpdate]);

  const updateLock = useCallback((id: number, updates: Partial<LockState>) => {
    setLocalRoom((prev) => {
      const updated = {
        ...prev,
        locks: prev.locks.map((l) => (l.id === id ? { ...l, ...updates } : l)),
      };
      onUpdate(updated);
      return updated;
    });
  }, [onUpdate]);

  const hasContent =
    localRoom.lights.length > 0 ||
    localRoom.thermostats.length > 0 ||
    localRoom.audio !== null ||
    localRoom.locks.length > 0;

  if (!hasContent) return null;

  return (
    <div className="bg-gray-900 rounded-xl shadow-lg border border-gray-800 overflow-hidden">
      <div className="px-4 py-3 bg-gray-800/50 border-b border-gray-700">
        <h2 className="text-sm font-semibold text-white">{localRoom.name}</h2>
      </div>
      <div className="p-4 space-y-4">
        {localRoom.lights.length > 0 && (
          <LightGroup lights={localRoom.lights} onOptimisticUpdate={updateLight} />
        )}
        {localRoom.thermostats.length > 0 && (
          <div className={localRoom.lights.length > 0 ? "border-t border-gray-800 pt-4" : ""}>
            <ThermostatCard thermostats={localRoom.thermostats} onOptimisticUpdate={updateThermostat} />
          </div>
        )}
        {localRoom.audio && (
          <div className={localRoom.lights.length > 0 || localRoom.thermostats.length > 0 ? "border-t border-gray-800 pt-4" : ""}>
            <AudioZone audio={localRoom.audio} onOptimisticUpdate={updateAudio} />
          </div>
        )}
        {localRoom.locks.length > 0 && (
          <div className="border-t border-gray-800 pt-4">
            <LockControl locks={localRoom.locks} onOptimisticUpdate={updateLock} />
          </div>
        )}
      </div>
    </div>
  );
}

import { useState } from "react";
import type { ThermostatState } from "../types";
import { sendCommand } from "../api";

type Props = {
  thermostats: ThermostatState[];
  onOptimisticUpdate: (id: number, updates: Partial<ThermostatState>) => void;
};

const MODES = ["Heat", "Cool", "Auto", "Off"] as const;
type Mode = (typeof MODES)[number];

const MODE_COMMANDS: Record<Mode, string> = {
  Heat: "HEAT",
  Cool: "COOL",
  Auto: "AUTO",
  Off: "OFF",
};

export function ThermostatCard({ thermostats, onOptimisticUpdate }: Props) {
  const [pending, setPending] = useState<string | null>(null);

  if (thermostats.length === 0) return null;

  const adjustSetpoint = async (
    t: ThermostatState,
    which: "heat" | "cool",
    delta: number,
  ) => {
    const current = which === "heat" ? t.heatSetpointF : t.coolSetpointF;
    if (current == null) return;
    const newVal = current + delta;
    const key = which === "heat" ? "heatSetpointF" : "coolSetpointF";
    onOptimisticUpdate(t.id, { [key]: newVal });
    const pendingKey = `${t.id}-${which}`;
    setPending(pendingKey);
    try {
      const command = which === "heat" ? "SET_SETPOINT_HEAT" : "SET_SETPOINT_COOL";
      await sendCommand(t.id, command, { FAHRENHEIT: String(newVal) });
    } catch (err) {
      console.error("setpoint error:", err);
      onOptimisticUpdate(t.id, { [key]: current });
    } finally {
      setPending((p) => (p === pendingKey ? null : p));
    }
  };

  const setMode = async (t: ThermostatState, mode: Mode) => {
    const prev = t.hvacMode;
    onOptimisticUpdate(t.id, { hvacMode: mode });
    const pendingKey = `${t.id}-mode`;
    setPending(pendingKey);
    try {
      await sendCommand(t.id, "SET_HVAC_MODE", { MODE: MODE_COMMANDS[mode] });
    } catch (err) {
      console.error("mode error:", err);
      onOptimisticUpdate(t.id, { hvacMode: prev });
    } finally {
      setPending((p) => (p === pendingKey ? null : p));
    }
  };

  return (
    <div className="space-y-4">
      <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">Thermostat</span>

      {thermostats.map((t) => (
        <div key={t.id} className="space-y-3">
          {thermostats.length > 1 && (
            <div className="text-xs text-gray-500">{t.name}</div>
          )}

          {/* Current temperature */}
          <div className="text-center">
            <span className="text-4xl font-light text-white">
              {t.tempF != null ? `${t.tempF}°F` : "—"}
            </span>
          </div>

          {/* Heat setpoint */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-orange-400 w-12">Heat</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => adjustSetpoint(t, "heat", -1)}
                disabled={pending === `${t.id}-heat`}
                className="w-7 h-7 rounded bg-gray-700 hover:bg-gray-600 text-white text-sm flex items-center justify-center disabled:opacity-50"
              >▼</button>
              <span className="text-sm text-white w-12 text-center">
                {t.heatSetpointF != null ? `${t.heatSetpointF}°F` : "—"}
              </span>
              <button
                onClick={() => adjustSetpoint(t, "heat", 1)}
                disabled={pending === `${t.id}-heat`}
                className="w-7 h-7 rounded bg-gray-700 hover:bg-gray-600 text-white text-sm flex items-center justify-center disabled:opacity-50"
              >▲</button>
            </div>
          </div>

          {/* Cool setpoint */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-blue-400 w-12">Cool</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => adjustSetpoint(t, "cool", -1)}
                disabled={pending === `${t.id}-cool`}
                className="w-7 h-7 rounded bg-gray-700 hover:bg-gray-600 text-white text-sm flex items-center justify-center disabled:opacity-50"
              >▼</button>
              <span className="text-sm text-white w-12 text-center">
                {t.coolSetpointF != null ? `${t.coolSetpointF}°F` : "—"}
              </span>
              <button
                onClick={() => adjustSetpoint(t, "cool", 1)}
                disabled={pending === `${t.id}-cool`}
                className="w-7 h-7 rounded bg-gray-700 hover:bg-gray-600 text-white text-sm flex items-center justify-center disabled:opacity-50"
              >▲</button>
            </div>
          </div>

          {/* Mode buttons */}
          <div className="flex gap-1">
            {MODES.map((mode) => {
              const active = t.hvacMode?.toLowerCase() === mode.toLowerCase();
              const colors: Record<Mode, string> = {
                Heat: "bg-orange-500 text-white",
                Cool: "bg-blue-500 text-white",
                Auto: "bg-green-500 text-white",
                Off: "bg-gray-500 text-white",
              };
              return (
                <button
                  key={mode}
                  onClick={() => setMode(t, mode)}
                  disabled={pending === `${t.id}-mode`}
                  className={`flex-1 py-1 text-xs rounded transition-colors ${
                    active
                      ? colors[mode]
                      : "bg-gray-700 text-gray-400 hover:bg-gray-600 hover:text-white"
                  } disabled:opacity-50`}
                >
                  {mode}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

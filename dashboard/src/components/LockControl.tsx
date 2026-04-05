import { useState } from "react";
import type { LockState } from "../types";
import { sendCommand } from "../api";

type Props = {
  locks: LockState[];
  onOptimisticUpdate: (id: number, updates: Partial<LockState>) => void;
};

export function LockControl({ locks, onOptimisticUpdate }: Props) {
  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set());

  const toggle = async (lock: LockState) => {
    const newLocked = !lock.locked;
    onOptimisticUpdate(lock.id, { locked: newLocked });
    setPendingIds((prev) => new Set(prev).add(lock.id));
    try {
      await sendCommand(lock.id, newLocked ? "CLOSE" : "OPEN");
    } catch (err) {
      console.error("lock error:", err);
      onOptimisticUpdate(lock.id, { locked: lock.locked });
    } finally {
      setPendingIds((prev) => {
        const next = new Set(prev);
        next.delete(lock.id);
        return next;
      });
    }
  };

  if (locks.length === 0) return null;

  return (
    <div className="space-y-2">
      <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">Locks</span>

      {locks.map((lock) => {
        const isPending = pendingIds.has(lock.id);
        const icon =
          lock.locked === true
            ? "🔒"
            : lock.locked === false
              ? "🔓"
              : "❓";
        const statusColor =
          lock.locked === true
            ? "text-green-400"
            : lock.locked === false
              ? "text-red-400"
              : "text-gray-500";

        return (
          <div key={lock.id} className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className={`text-xl ${statusColor}`}>{icon}</span>
              <span className="text-sm text-gray-200">{lock.name}</span>
            </div>
            <button
              onClick={() => toggle(lock)}
              disabled={isPending || lock.locked === null}
              className={`text-xs px-3 py-1 rounded transition-colors disabled:opacity-50 ${
                lock.locked
                  ? "bg-red-900/30 text-red-300 hover:bg-red-900/50"
                  : "bg-green-900/30 text-green-300 hover:bg-green-900/50"
              }`}
            >
              {isPending ? "…" : lock.locked ? "Unlock" : "Lock"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

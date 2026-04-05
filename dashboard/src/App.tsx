import { useCallback } from "react";
import { useHomeState } from "./hooks/useHomeState";
import { RoomCard } from "./components/RoomCard";
import { NLInput } from "./components/NLInput";
import type { RoomState } from "./types";

export function App() {
  const { state, error, connected, refresh } = useHomeState();

  const handleRoomUpdate = useCallback(
    (_updated: RoomState) => {
      // Optimistic updates are applied locally in RoomCard's state.
      // Nothing needed here — SSE patches will confirm from server.
    },
    [],
  );

  return (
    <div className="min-h-screen bg-gray-950 pb-20">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-gray-950/90 backdrop-blur-md border-b border-gray-800">
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-lg">🏠</span>
            <h1 className="text-white font-semibold">Home Dashboard</h1>
          </div>
          <div className="flex items-center gap-3">
            {state && (
              <span className="text-xs text-gray-500">
                {new Date(state.fetchedAt).toLocaleTimeString()}
              </span>
            )}
            <div
              className={`w-2 h-2 rounded-full ${
                connected ? "bg-green-400" : "bg-red-400 animate-pulse"
              }`}
              title={connected ? "Connected" : "Reconnecting…"}
            />
          </div>
        </div>
        {error && (
          <div className="bg-red-950/50 border-b border-red-800/50 px-4 py-2 text-xs text-red-300 text-center">
            {error}
          </div>
        )}
      </header>

      {/* Main content */}
      <main className="max-w-5xl mx-auto px-4 py-6">
        {!state ? (
          <div className="flex flex-col items-center justify-center gap-4 mt-20 text-gray-400">
            <div className="w-8 h-8 border-2 border-gray-700 border-t-blue-500 rounded-full animate-spin" />
            <p className="text-sm">Loading home state…</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {state.rooms.map((room) => (
              <RoomCard
                key={room.id}
                room={room}
                onUpdate={handleRoomUpdate}
              />
            ))}
          </div>
        )}
      </main>

      {/* Natural language input */}
      <NLInput onCommandsExecuted={refresh} />
    </div>
  );
}

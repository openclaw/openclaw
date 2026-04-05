import { useState, useEffect, useCallback } from "react";
import type { HomeState, RoomState } from "../types";

type UseHomeStateResult = {
  state: HomeState | null;
  error: string | null;
  connected: boolean;
  refresh: () => void;
};

export function useHomeState(): UseHomeStateResult {
  const [state, setState] = useState<HomeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  const applyPatch = useCallback((changedRooms: RoomState[], fetchedAt: number) => {
    setState((prev) => {
      if (!prev) return prev;
      const roomMap = new Map(prev.rooms.map((r) => [r.id, r]));
      for (const room of changedRooms) {
        roomMap.set(room.id, room);
      }
      return { rooms: Array.from(roomMap.values()), fetchedAt };
    });
  }, []);

  const fetchState = useCallback(async () => {
    try {
      const res = await fetch("/api/state");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: HomeState = await res.json();
      setState(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    // Initial state fetch (in case SSE isn't fast enough)
    fetchState();

    const es = new EventSource("/api/events");

    es.addEventListener("init", (e) => {
      const data: HomeState = JSON.parse(e.data);
      setState(data);
      setConnected(true);
      setError(null);
    });

    es.addEventListener("patch", (e) => {
      const data: { rooms: RoomState[]; fetchedAt: number } = JSON.parse(e.data);
      applyPatch(data.rooms, data.fetchedAt);
    });

    es.addEventListener("ping", () => {
      setConnected(true);
    });

    es.onerror = () => {
      setConnected(false);
      setError("Connection lost — reconnecting…");
    };

    es.onopen = () => {
      setConnected(true);
      setError(null);
    };

    return () => {
      es.close();
    };
  }, [applyPatch, fetchState]);

  return { state, error, connected, refresh: fetchState };
}

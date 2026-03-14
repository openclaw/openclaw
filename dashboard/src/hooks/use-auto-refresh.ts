"use client";

import { useState, useEffect, useCallback, useRef } from "react";

interface UseAutoRefreshOptions {
  interval?: number;
  enabled?: boolean;
}

interface UseAutoRefreshResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  lastUpdated: Date | null;
  refresh: () => void;
}

export function useAutoRefresh<T>(
  url: string,
  options: UseAutoRefreshOptions = {}
): UseAutoRefreshResult<T> {
  const { interval = 15000, enabled = true } = options;
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const mountedRef = useRef(true);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      if (mountedRef.current) {
        setData(json.data ?? json);
        setError(null);
        setLastUpdated(new Date());
        setLoading(false);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "Unknown error");
        setLoading(false);
      }
    }
  }, [url]);

  useEffect(() => {
    mountedRef.current = true;
    fetchData();

    if (!enabled) return;

    const timer = setInterval(fetchData, interval);
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
    };
  }, [fetchData, interval, enabled]);

  return { data, loading, error, lastUpdated, refresh: fetchData };
}

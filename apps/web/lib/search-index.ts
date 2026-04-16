"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import Fuse from "fuse.js";

// --- Types (must match the API response) ---

export type SearchIndexItem = {
  id: string;
  label: string;
  sublabel?: string;
  kind: "file" | "object" | "entry";
  icon?: string;
  objectName?: string;
  entryId?: string;
  fields?: Record<string, string>;
  path?: string;
  nodeType?: "document" | "folder" | "file" | "report" | "database";
  defaultView?: "table" | "kanban";
};

// --- Fuse.js config ---

const FUSE_OPTIONS: ConstructorParameters<typeof Fuse<SearchIndexItem>>[1] = {
  keys: [
    { name: "label", weight: 3 },
    { name: "sublabel", weight: 1 },
    { name: "objectName", weight: 1.5 },
    // Search within field values for entries
    { name: "fieldValues", weight: 2 },
  ],
  threshold: 0.4,
  distance: 200,
  includeScore: true,
  shouldSort: true,
  minMatchCharLength: 1,
};

/** Flatten field values into a searchable string for Fuse.js. */
function enrichForSearch(
  items: SearchIndexItem[],
): Array<SearchIndexItem & { fieldValues?: string }> {
  return items.map((item) => ({
    ...item,
    fieldValues: item.fields
      ? Object.values(item.fields).join(" ")
      : undefined,
  }));
}

// --- Hook ---

/**
 * Hook that fetches the workspace search index and provides fuzzy search.
 * Refetches when `refreshSignal` changes (wire to tree watcher refresh count).
 */
export function useSearchIndex(refreshSignal?: number) {
  const [items, setItems] = useState<SearchIndexItem[]>([]);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);

  const fetchIndex = useCallback(async () => {
    try {
      const res = await fetch("/api/workspace/search-index");
      const data = await res.json();
      if (mountedRef.current) {
        setItems(data.items ?? []);
        setLoading(false);
      }
    } catch {
      if (mountedRef.current) {setLoading(false);}
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void fetchIndex();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchIndex, refreshSignal]);

  // Build the Fuse instance whenever items change
  const fuse = useMemo(() => {
    if (items.length === 0) {return null;}
    const enriched = enrichForSearch(items);
    return new Fuse(enriched, FUSE_OPTIONS);
  }, [items]);

  /** Inner search implementation (recreated when fuse/items change). */
  const searchImpl = useCallback(
    (query: string, limit = 20): SearchIndexItem[] => {
      if (!query.trim()) {
        // No query: return first N items, files/objects first, then entries
        const sorted = [...items].toSorted((a, b) => {
          const kindOrder = { object: 0, file: 1, entry: 2 };
          return (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9);
        });
        return sorted.slice(0, limit);
      }

      if (!fuse) {return [];}

      const results = fuse.search(query, { limit });
      return results.map((r) => r.item);
    },
    [fuse, items],
  );

  // Keep a ref to the latest implementation so the tiptap extension
  // (which captures the search function at creation time) always calls
  // the current version, not a stale closure.
  const searchImplRef = useRef(searchImpl);
  searchImplRef.current = searchImpl;

  /**
   * Stable search function -- identity never changes, but always delegates
   * to the latest searchImpl via ref. Safe to capture in closures/extensions.
   */
  const search = useCallback(
    (query: string, limit?: number): SearchIndexItem[] => {
      return searchImplRef.current(query, limit);
    },
    [],
  );

  return { items, loading, search };
}

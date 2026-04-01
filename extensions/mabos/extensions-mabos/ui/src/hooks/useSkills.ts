import { useState, useEffect, useCallback } from "react";

type Skill = {
  name: string;
  version: string;
  description: string;
  author: string;
  tags: string[];
  installedAt?: string;
};

type SkillsState = {
  skills: Skill[];
  searchResults: Skill[];
  isLoading: boolean;
  error: string | null;
};

export function useSkills() {
  const [state, setState] = useState<SkillsState>({
    skills: [],
    searchResults: [],
    isLoading: true,
    error: null,
  });

  const fetchSkills = useCallback(async () => {
    setState((prev) => ({ ...prev, isLoading: true, error: null }));
    try {
      const res = await fetch("/mabos/skills");
      if (!res.ok) throw new Error("Failed to fetch skills");
      const skills: Skill[] = await res.json();
      setState((prev) => ({ ...prev, skills, isLoading: false, error: null }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        isLoading: false,
        error: err instanceof Error ? err.message : "Unknown error",
      }));
    }
  }, []);

  const search = useCallback(async (query: string) => {
    if (!query.trim()) {
      setState((prev) => ({ ...prev, searchResults: [] }));
      return;
    }
    setState((prev) => ({ ...prev, isLoading: true }));
    try {
      const res = await fetch(`/mabos/skills/search?q=${encodeURIComponent(query.trim())}`);
      if (!res.ok) throw new Error("Search failed");
      const searchResults: Skill[] = await res.json();
      setState((prev) => ({ ...prev, searchResults, isLoading: false }));
    } catch (err) {
      setState((prev) => ({
        ...prev,
        searchResults: [],
        isLoading: false,
        error: err instanceof Error ? err.message : "Search failed",
      }));
    }
  }, []);

  useEffect(() => {
    fetchSkills();
  }, [fetchSkills]);

  return {
    skills: state.skills,
    searchResults: state.searchResults,
    isLoading: state.isLoading,
    error: state.error,
    search,
    refresh: fetchSkills,
  };
}

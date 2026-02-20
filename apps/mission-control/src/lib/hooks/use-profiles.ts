"use client";

import {
  createElement,
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";

// --- Types ---

export interface Profile {
  id: string;
  name: string;
  avatar_color: string;
  avatar_emoji: string;
  is_default: number;
  created_at: string;
  workspaces: Array<{
    profile_id: string;
    workspace_id: string;
    role: string;
    label: string;
    color: string;
  }>;
}

export interface ProfileContextType {
  profiles: Profile[];
  activeProfile: Profile | null;
  setActiveProfileId: (id: string) => void;
  refreshProfiles: () => Promise<void>;
  loading: boolean;
}

// --- Context ---

const STORAGE_KEY = "oc-active-profile";

export const ProfileContext = createContext<ProfileContextType | null>(null);

// --- Hook ---

export function useProfiles(): ProfileContextType {
  const ctx = useContext(ProfileContext);
  if (!ctx) {
    throw new Error("useProfiles must be used within a ProfileProvider");
  }
  return ctx;
}

// --- Provider ---

export function ProfileProvider({ children }: { children: ReactNode }) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return localStorage.getItem(STORAGE_KEY);
  });
  const [loading, setLoading] = useState(true);

  const loadProfiles = useCallback(async () => {
    try {
      const res = await fetch("/api/profiles");
      const data = await res.json();
      return (data.profiles || []) as Profile[];
    } catch {
      return [] as Profile[];
    }
  }, []);

  const refreshProfiles = useCallback(async () => {
    const fetched = await loadProfiles();
    setProfiles(fetched);
  }, [loadProfiles]);

  // Set active profile ID and persist to localStorage + cookie
  const handleSetActiveProfileId = useCallback((id: string) => {
    setActiveProfileId(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
      // Also set as a cookie so the server can read it (profile-context.ts)
      document.cookie = `${STORAGE_KEY}=${encodeURIComponent(id)};path=/;max-age=${60 * 60 * 24 * 365};samesite=strict`;
    } catch {
      // Ignore storage errors.
    }
  }, []);

  // Initial fetch on mount
  useEffect(() => {
    let cancelled = false;

    void loadProfiles().then((fetched) => {
      if (cancelled) return;
      setProfiles(fetched);
      setLoading(false);

      // Auto-select if no active profile is set
      const storedId = localStorage.getItem(STORAGE_KEY);
      const hasStored = storedId && fetched.some((p) => p.id === storedId);

      if (!hasStored && fetched.length > 0) {
        const defaultProfile = fetched.find((p) => p.is_default === 1);
        const selected = defaultProfile || fetched[0];
        handleSetActiveProfileId(selected.id);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [loadProfiles, handleSetActiveProfileId]);

  // Derive active profile from current profiles + activeProfileId
  const activeProfile =
    profiles.find((p) => p.id === activeProfileId) ?? null;

  return createElement(
    ProfileContext.Provider,
    {
      value: {
        profiles,
        activeProfile,
        setActiveProfileId: handleSetActiveProfileId,
        refreshProfiles,
        loading,
      },
    },
    children,
  );
}

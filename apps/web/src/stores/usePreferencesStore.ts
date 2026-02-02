/**
 * User Preferences Store
 * Manages user preferences and feature flags
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ChatBackend = "gateway" | "vercel-ai";

interface PreferencesState {
  // Chat backend selection
  chatBackend: ChatBackend;

  // Actions
  setChatBackend: (backend: ChatBackend) => void;
  reset: () => void;
}

const initialState = {
  chatBackend: "gateway" as ChatBackend, // Default to gateway for backwards compatibility
};

export const usePreferencesStore = create<PreferencesState>()(
  persist(
    (set) => ({
      ...initialState,

      setChatBackend: (backend) => {
        set({ chatBackend: backend });
      },

      reset: () => {
        set(initialState);
      },
    }),
    {
      name: "clawdbrain-preferences", // localStorage key
    }
  )
);

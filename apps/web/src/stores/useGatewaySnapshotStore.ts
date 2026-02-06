import { create } from "zustand";
import type {
  GatewaySnapshot,
  GatewayStateVersion,
  HealthSnapshot,
  PresenceEntry,
  SessionDefaultsSnapshot,
} from "@/lib/api/gateway-snapshot";

export interface GatewaySnapshotState {
  presence: PresenceEntry[];
  health: HealthSnapshot | null;
  sessionDefaults: SessionDefaultsSnapshot | null;
  stateVersion: GatewayStateVersion | null;
}

export interface GatewaySnapshotActions {
  setPresence: (presence: PresenceEntry[]) => void;
  setHealth: (health: HealthSnapshot) => void;
  setSessionDefaults: (defaults: SessionDefaultsSnapshot) => void;
  setStateVersion: (version: GatewayStateVersion) => void;
  applySnapshot: (snapshot?: GatewaySnapshot) => void;
}

export type GatewaySnapshotStore = GatewaySnapshotState & GatewaySnapshotActions;

export const useGatewaySnapshotStore = create<GatewaySnapshotStore>()((set) => ({
  presence: [],
  health: null,
  sessionDefaults: null,
  stateVersion: null,

  setPresence: (presence) => set({ presence }),
  setHealth: (health) => set({ health }),
  setSessionDefaults: (defaults) => set({ sessionDefaults: defaults }),
  setStateVersion: (version) => set({ stateVersion: version }),
  applySnapshot: (snapshot) => {
    if (!snapshot) {return;}
    set((state) => ({
      presence: snapshot.presence ?? state.presence,
      health: snapshot.health ?? state.health,
      sessionDefaults: snapshot.sessionDefaults ?? state.sessionDefaults,
      stateVersion: snapshot.stateVersion ?? state.stateVersion,
    }));
  },
}));

export default useGatewaySnapshotStore;

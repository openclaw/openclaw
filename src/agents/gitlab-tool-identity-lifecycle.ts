import { notifyListeners, registerListener } from "../shared/listeners.js";

type ProfileChange = { profileDir: string; kind: "updated" | "removed" };
const profileListeners = new Set<(change: ProfileChange) => void>();

export function onManagedGitLabProfileChanged(listener: (change: ProfileChange) => void) {
  return registerListener(profileListeners, listener);
}

export function notifyManagedGitLabProfileChanged(change: ProfileChange): void {
  notifyListeners(profileListeners, change);
}

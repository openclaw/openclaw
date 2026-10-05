import { notifyListeners, registerListener } from "../shared/listeners.js";

const profileListeners = new Set<(profileDir: string) => void>();

/** Selected execution copies follow completed writes by the existing profile owner. */
export function onManagedGitHubProfileChanged(listener: (profileDir: string) => void): () => void {
  return registerListener(profileListeners, listener);
}

export function notifyManagedGitHubProfileChanged(profileDir: string): void {
  notifyListeners(profileListeners, profileDir);
}

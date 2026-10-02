import path from "node:path";

/** Explicit store paths travel with session scope into database Workers. */
export function createCommandSessionPaths(root: string) {
  return {
    sessions: path.join(root, "visible", "agents", "default", "sessions", "sessions.json"),
    internalStore: path.join(root, "internal", "agents", "default", "sessions", "sessions.json"),
  };
}

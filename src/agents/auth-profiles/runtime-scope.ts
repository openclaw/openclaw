import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthProfileStore } from "./types.js";

type AuthProfileRuntimeMode =
  | { kind: "env-only" }
  | { kind: "agent-dir"; agentDir: string; sharedStore?: AuthProfileStore; env: NodeJS.ProcessEnv };

export const authProfileRuntimeMode = new AsyncLocalStorage<AuthProfileRuntimeMode>();

export function assertPersonalAuthProfileRuntime(): void {
  if (authProfileRuntimeMode.getStore()) {
    throw new Error("Personal model accounts are unavailable in an isolated auth-store scope.");
  }
}

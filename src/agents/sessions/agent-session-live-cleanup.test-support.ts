import { rm } from "node:fs/promises";
import type { AgentSession } from "./agent-session.js";

export async function cleanupLiveSessions(sessions: AgentSession[], tempRoots: string[]) {
  for (const session of sessions.splice(0)) {
    session.dispose();
  }
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
}

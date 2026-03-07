import type { PluginRuntime } from "openclaw/plugin-sdk";

let runtime: PluginRuntime | null = null;

export function setPumbleRuntime(next: PluginRuntime) {
  runtime = next;
}

export function getPumbleRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error("Pumble runtime not initialized");
  }
  return runtime;
}

// Thread context store: maps sessionKey → { to, threadRootId } so the
// before_tool_call hook can auto-inject replyTo for message tool sends
// that target the originating channel thread.
export type PumbleThreadContext = {
  to: string;
  threadRootId: string;
};

const threadContextMap = new Map<string, PumbleThreadContext>();

export function setPumbleThreadContext(sessionKey: string, ctx: PumbleThreadContext) {
  threadContextMap.set(sessionKey, ctx);
}

export function getPumbleThreadContext(sessionKey: string): PumbleThreadContext | undefined {
  return threadContextMap.get(sessionKey);
}

export function clearPumbleThreadContext(sessionKey: string) {
  threadContextMap.delete(sessionKey);
}

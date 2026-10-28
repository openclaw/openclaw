/** Foreground contexts protect workspace/profile scopes that do not identify one session. */
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";

const uses = new Map<string, number>();
const usageKey = (scopeKey: string) => JSON.stringify([resolveOpenClawStateSqlitePath(), scopeKey]);

export function retainSandboxContainerUsage(scopeKey: string): () => void {
  const key = usageKey(scopeKey);
  uses.set(key, (uses.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    const remaining = uses.get(key)! - 1;
    if (remaining) {
      uses.set(key, remaining);
    } else {
      uses.delete(key);
    }
  };
}

export function isSandboxContainerInUse(scopeKey: string): boolean {
  return uses.has(usageKey(scopeKey));
}

import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";
export type NativeChildToolSource = NonNullable<
  ReturnType<NonNullable<AgentHarnessHostCapabilities["retainSourceAuthority"]>>
>;
type ChildCall = {
  toolName: string;
  threadId: string;
  childRunId: string;
  signal: AbortSignal;
  assertCurrent(): void;
};
type Run = <T>(
  request: ChildCall,
  execute: (host: AgentHarnessHostCapabilities, runId: string) => Promise<T>,
) => Promise<T>;

const childHosts = resolveGlobalSingleton(
  Symbol.for("openclaw.codex.nativeChildToolHosts"),
  () => new WeakMap<NativeChildToolSource, { parent: AgentHarnessHostCapabilities; run: Run }>(),
);

const issuers = resolveGlobalSingleton(
  Symbol.for("openclaw.codex.nativeChildToolIssuers"),
  () => new WeakMap<AgentHarnessHostCapabilities, (source: NativeChildToolSource) => void>(),
);
export function registerNativeChildToolIssuer(
  parent: AgentHarnessHostCapabilities,
  attach: (source: NativeChildToolSource) => void,
) {
  issuers.set(parent, attach);
}
export function retainCodexNativeChildToolSource(parent: AgentHarnessHostCapabilities) {
  const source = parent.retainSourceAuthority?.();
  try {
    if (source) {
      issuers.get(parent)?.(source);
    }
    return source;
  } catch (error) {
    source?.release();
    throw error;
  }
}
export function bindNativeChildToolSource(
  source: NativeChildToolSource,
  parent: AgentHarnessHostCapabilities,
  run: Run,
) {
  childHosts.set(source, { parent, run });
}
export async function runWithCodexNativeChildToolHost<T>(
  parent: AgentHarnessHostCapabilities,
  source: NativeChildToolSource,
  request: ChildCall,
  execute: (host: AgentHarnessHostCapabilities, runId: string) => Promise<T>,
): Promise<T> {
  const bound = childHosts.get(source);
  if (!bound || bound.parent !== parent) {
    throw new Error("No retained OpenClaw tool authority for this native child.");
  }
  return await bound.run(request, execute);
}

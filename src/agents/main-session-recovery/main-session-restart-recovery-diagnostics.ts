import { truncateWithMarker } from "@openclaw/normalization-core/utf16-slice";
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { getAgentRunLifecycleGeneration } from "../../infra/agent-run-registry.js";
import { redactSensitiveText } from "../../logging/redact.js";
import type { MainSessionRecoveryStoreTarget } from "./main-session-recovery-store.js";

export type RestartRecoveryStoreTarget = Pick<
  MainSessionRecoveryStoreTarget,
  "agentId" | "storePath"
>;

let failureGeneration: string | undefined;
const failures = new Map<string, string>();

export function restartRecoveryStoreTargetKey(target: RestartRecoveryStoreTarget): string {
  return JSON.stringify([target.agentId, target.storePath]);
}

function currentFailures(): Map<string, string> {
  const generation = getAgentRunLifecycleGeneration();
  if (failureGeneration !== generation) {
    failures.clear();
    failureGeneration = generation;
  }
  return failures;
}

/** The marker records its outcome; diagnostics never infer successful recovery from a reread. */
export function recordStartupRecoveryStoreResult(params: {
  target: RestartRecoveryStoreTarget;
  lifecycleGeneration: string;
  outcome: { ok: true } | { ok: false; error: unknown };
}): void {
  if (params.lifecycleGeneration !== getAgentRunLifecycleGeneration()) {
    return;
  }
  const pending = currentFailures();
  const key = restartRecoveryStoreTargetKey(params.target);
  if (params.outcome.ok) {
    pending.delete(key);
  } else {
    pending.set(
      key,
      truncateWithMarker(
        sanitizeTerminalText(
          redactSensitiveText(
            `${params.target.agentId ?? "session store"}: ${String(params.outcome.error)}`,
            { mode: "tools" },
          ),
        ),
        2000,
        { marker: "… (see recovery log)", reserve: 22, trimEnd: true },
      ),
    );
  }
}

export function readStartupRecoveryWarning(includeSensitive = true): string | undefined {
  const pending = currentFailures();
  if (pending.size === 0) {
    return undefined;
  }
  const summary = `Startup session recovery is incomplete for ${pending.size} session store(s).`;
  const hint =
    "Inspect the Gateway recovery logs and retry the affected session after repairing its store.";
  const details = includeSensitive
    ? `\n${truncateWithMarker([...pending.values()].map((failure) => `- ${failure}`).join("\n"), 2000, { marker: "… (see recovery log)", reserve: 22, trimEnd: true })}`
    : "";
  return `${summary}${details}\n${hint}`;
}

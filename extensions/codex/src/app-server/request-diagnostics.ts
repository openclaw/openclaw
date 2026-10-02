import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-registration";
import { areDiagnosticsEnabledForProcess } from "openclaw/plugin-sdk/diagnostic-runtime";
import { CODEX_CONTROL_METHODS } from "./capabilities.js";
import type { CodexAppServerClient } from "./client.js";
import type { CodexAppServerAcquireObservation } from "./shared-client.js";

// This is a disclosure allowlist, not request validation. Unknown method strings
// can contain caller data; never copy them into diagnostics.
const DIAGNOSTIC_METHODS = new Set<string>([
  ...Object.values(CODEX_CONTROL_METHODS),
  "model/list",
  "thread/start",
  "plugin/installed",
  "plugin/read",
  "config/read",
  "config/value/write",
  "config/batchWrite",
  "configRequirements/read",
  "experimentalFeature/list",
]);
const MAX_METHODS = 8;
type InitializeSnapshot = ReturnType<CodexAppServerClient["getInitializeDiagnostic"]>;

type ReadInitializeSnapshot = (beforeClientClose?: boolean) => InitializeSnapshot;
function readInitializeSnapshot(read: ReadInitializeSnapshot | undefined, beforeClose = false) {
  try {
    return read?.(beforeClose);
  } catch {
    return undefined;
  }
}

/** Counts awaited APIs, not native execution or proof that a request was written. */
export function createCodexRequestTimeoutDiagnostics(timeoutMs: number) {
  if (!areDiagnosticsEnabledForProcess() || !embeddedAgentLog.isEnabled("warn")) {
    return undefined;
  }
  const startedAt = performance.now();
  let attempt = createAttempt(0);
  function createAttempt(ordinal: number): {
    ordinal: number;
    phase: "prepare" | "acquire-client" | "callback" | "release-client";
    clientInstanceId: string | undefined;
    acquireLastObservedBoundary: CodexAppServerAcquireObservation["boundary"] | undefined;
    acquireBoundaryBeforeCleanup: CodexAppServerAcquireObservation["boundary"] | undefined;
    acquireStartup: CodexAppServerAcquireObservation["startup"];
    lastStartedClientInstanceId: string | undefined;
    initializeSnapshot: ReadInitializeSnapshot | undefined;
    initializeBeforeCleanup: InitializeSnapshot;
    initializeBeforeCleanupSource: "at-cleanup" | "before-client-close" | undefined;
    started: number;
    pending: number;
    methods: Map<string, number>;
  } {
    return {
      ordinal,
      phase: "prepare",
      clientInstanceId: undefined,
      acquireLastObservedBoundary: undefined,
      acquireBoundaryBeforeCleanup: undefined,
      acquireStartup: undefined,
      lastStartedClientInstanceId: undefined,
      initializeSnapshot: undefined,
      initializeBeforeCleanup: undefined,
      initializeBeforeCleanupSource: undefined,
      started: 0,
      pending: 0,
      methods: new Map<string, number>(),
    };
  }
  return {
    beginAttempt(ordinal: number) {
      // Late settlement from the previous callback must not change its replacement.
      attempt = createAttempt(ordinal);
      attempt.phase = "acquire-client";
      const current = attempt;
      return {
        onAcquireObservation(observation: CodexAppServerAcquireObservation) {
          if (attempt !== current || current.phase !== "acquire-client") {
            return;
          }
          if (observation.boundary === "cleanup") {
            if (current.acquireLastObservedBoundary !== "cleanup") {
              current.acquireBoundaryBeforeCleanup = current.acquireLastObservedBoundary;
              const snapshot = readInitializeSnapshot(current.initializeSnapshot);
              current.initializeBeforeCleanup = snapshot?.clientClosed
                ? readInitializeSnapshot(current.initializeSnapshot, true)
                : snapshot;
              current.initializeBeforeCleanupSource = current.initializeBeforeCleanup
                ? snapshot?.clientClosed
                  ? "before-client-close"
                  : "at-cleanup"
                : undefined;
            }
          } else {
            current.acquireBoundaryBeforeCleanup = undefined;
            current.initializeBeforeCleanup = undefined;
            current.initializeBeforeCleanupSource = undefined;
          }
          current.acquireLastObservedBoundary = observation.boundary;
          if (observation.startup) {
            current.acquireStartup = observation.startup;
          }
        },
        onStartedClient(client: CodexAppServerClient) {
          if (attempt !== current || current.phase !== "acquire-client") {
            return;
          }
          // Fallback can replace this client; this identity is an observation, not a lease.
          current.lastStartedClientInstanceId = undefined;
          current.initializeSnapshot = undefined;
          current.initializeBeforeCleanup = undefined;
          current.initializeBeforeCleanupSource = undefined;
          try {
            current.lastStartedClientInstanceId = client.getInstanceId();
            current.initializeSnapshot = (beforeClose) =>
              client.getInitializeDiagnostic(beforeClose);
          } catch {
            // A diagnostic identity cannot invalidate startup.
          }
        },
      };
    },
    acquired(client: CodexAppServerClient) {
      attempt.phase = "callback";
      try {
        attempt.clientInstanceId = client.getInstanceId();
      } catch {
        // A missing diagnostic identity cannot invalidate the acquired lease.
      }
    },
    request(method: string) {
      const current = attempt;
      const label = DIAGNOSTIC_METHODS.has(method) ? method : "other";
      current.started++;
      current.pending++;
      current.methods.set(label, (current.methods.get(label) ?? 0) + 1);
      return () => {
        current.pending--;
        const remaining = (current.methods.get(label) ?? 1) - 1;
        if (remaining === 0) {
          current.methods.delete(label);
        } else {
          current.methods.set(label, remaining);
        }
      };
    },
    release() {
      attempt.phase = "release-client";
    },
    timeout() {
      try {
        if (!areDiagnosticsEnabledForProcess() || !embeddedAgentLog.isEnabled("warn")) {
          return;
        }
        const methods = [...attempt.methods].toSorted(([a], [b]) => a.localeCompare(b));
        const initialize = readInitializeSnapshot(attempt.initializeSnapshot);
        embeddedAgentLog.warn("codex app-server scope timed out", {
          phase:
            attempt.phase === "callback" && attempt.pending > 0 ? "client-request" : attempt.phase,
          timeoutMs,
          elapsedMs: Math.round(performance.now() - startedAt),
          scopeAttemptOrdinal: attempt.ordinal,
          ...(attempt.acquireLastObservedBoundary
            ? { acquireLastObservedBoundary: attempt.acquireLastObservedBoundary }
            : {}),
          ...(attempt.acquireStartup ? { acquireStartup: attempt.acquireStartup } : {}),
          ...(attempt.acquireBoundaryBeforeCleanup
            ? { acquireBoundaryBeforeCleanup: attempt.acquireBoundaryBeforeCleanup }
            : {}),
          ...(attempt.lastStartedClientInstanceId
            ? { lastStartedClientInstanceId: attempt.lastStartedClientInstanceId }
            : {}),
          ...(attempt.clientInstanceId ? { clientInstanceId: attempt.clientInstanceId } : {}),
          ...(initialize ? { initializeSnapshot: JSON.stringify(initialize) } : {}),
          ...(attempt.initializeBeforeCleanup
            ? {
                initializeBeforeCleanup: JSON.stringify(attempt.initializeBeforeCleanup),
                initializeBeforeCleanupSource: attempt.initializeBeforeCleanupSource,
              }
            : {}),
          requestStartedCount: attempt.started,
          currentRequestCount: attempt.pending,
          // Scalar log attributes retain the bounded method/count tuples.
          currentMethods: JSON.stringify(methods.slice(0, MAX_METHODS)),
          omittedMethodCount: Math.max(0, methods.length - MAX_METHODS),
        });
      } catch {
        // Diagnostic sinks must not replace the timeout or prevent scope cleanup.
      }
    },
  };
}

import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
export type CrabboxProvisionStageEvent = {
  leaseId: string;
  operationId: string;
  stage: string;
  elapsedMs: number;
  totalElapsedMs: number;
  outcome: "started" | "completed" | "failed";
  errorCode?: string;
};

type Emit = (event: CrabboxProvisionStageEvent) => void;

function errorCode(error: unknown): string {
  const name = error instanceof Error ? error.name : "unknown";
  return /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name) ? name : "unknown";
}

export function createCrabboxProvisionTelemetry(
  operationId: string,
  leaseId: string,
  emit: Emit,
  now: () => number = () => performance.now(),
) {
  const startedAt = now();
  const publish = (event: CrabboxProvisionStageEvent) => {
    try {
      emit(event);
    } catch {
      // Telemetry is observational and cannot change provider custody.
    }
  };
  const stage = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const stageStartedAt = now();
    publish({
      leaseId,
      operationId,
      stage: name,
      elapsedMs: 0,
      totalElapsedMs: stageStartedAt - startedAt,
      outcome: "started",
    });
    try {
      const result = await run();
      publish({
        leaseId,
        operationId,
        stage: name,
        elapsedMs: now() - stageStartedAt,
        totalElapsedMs: now() - startedAt,
        outcome: "completed",
      });
      return result;
    } catch (error) {
      publish({
        leaseId,
        operationId,
        stage: name,
        elapsedMs: now() - stageStartedAt,
        totalElapsedMs: now() - startedAt,
        outcome: "failed",
        errorCode: errorCode(error),
      });
      throw error;
    }
  };
  return { stage };
}

const WORKER_STAGE_PREFIX = "CRABBOX_WORKER_STAGE:";
const WORKER_STAGES = new Set([
  "preparation",
  "desktop-setup",
  "complete",
  "runtime-verification",
  "download-connection",
  "download-tls",
  "download-http-response",
  "download-body",
  "worker-archive-verification",
  "worker-archive-publication",
  "installation-and-worker-download",
  "installation",
  "activation",
  "plugin-activation",
]);
/** Project only the allowlisted remote milestone; never log arbitrary command output. */
export function createCrabboxWorkerStageObserver(leaseId: string, operationId: string, emit: Emit) {
  let pending = "";
  return (chunk: Buffer, stream: "stdout" | "stderr") => {
    if (stream !== "stderr") {
      return;
    }
    pending += chunk.toString("utf8");
    if (pending.length > 2048) {
      pending = pending.slice(-2048);
    }
    let end: number;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end).trim();
      pending = pending.slice(end + 1);
      const marker = line.indexOf(WORKER_STAGE_PREFIX);
      if (marker < 0 || line.length > 512) {
        continue;
      }
      try {
        const value: unknown = JSON.parse(line.slice(marker + WORKER_STAGE_PREFIX.length));
        if (!isRecord(value)) {
          continue;
        }
        const event = value;
        if (
          event.leaseId !== leaseId ||
          typeof event.stage !== "string" ||
          !WORKER_STAGES.has(event.stage) ||
          (event.outcome !== "started" &&
            event.outcome !== "completed" &&
            event.outcome !== "failed") ||
          typeof event.elapsedMs !== "number" ||
          !Number.isSafeInteger(event.elapsedMs) ||
          event.elapsedMs < 0 ||
          typeof event.totalElapsedMs !== "number" ||
          !Number.isSafeInteger(event.totalElapsedMs) ||
          event.totalElapsedMs < event.elapsedMs
        ) {
          continue;
        }
        try {
          emit({
            leaseId,
            operationId,
            stage: `worker-${event.stage}`,
            elapsedMs: event.elapsedMs,
            totalElapsedMs: event.totalElapsedMs,
            outcome: event.outcome,
            ...(event.outcome === "failed" ? { errorCode: "bootstrap_failed" } : {}),
          });
        } catch {
          /* A diagnostic observer never changes command outcome. */
        }
      } catch {
        // Remote output is diagnostic, never an authority or a command result.
      }
    }
  };
}

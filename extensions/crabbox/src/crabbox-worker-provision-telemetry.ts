import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
const abortLog = createSubsystemLogger("crabbox/provision");
const ABORT_SOURCES = ["caller", "project", "runtime"] as const;
type AbortSource = (typeof ABORT_SOURCES)[number];
export type CrabboxProvisionStageEvent = {
  leaseId: string;
  operationId: string;
  stage: string;
  elapsedMs?: number;
  totalElapsedMs?: number;
  outcome: "started" | "completed" | "failed";
  errorCode?: string;
  runtimeCache?: {
    expectedSha256: string;
    homeCategory: "root" | "other";
    uidCategory: "root" | "non-root" | "unavailable";
    cacheHit: boolean;
    missReason: "none" | "runtime_missing" | "worker_archive_missing" | "verification_failed";
  };
  firstAbortSource?: AbortSource | "unknown" | "none";
  abortedSources?: AbortSource[];
  abortReasonCategory?: "abort" | "deadline" | "unknown";
};

type Emit = (event: CrabboxProvisionStageEvent) => void;

function errorCode(error: unknown): string {
  try {
    const name = error instanceof Error ? error.name : "unknown";
    return /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name) ? name : "unknown";
  } catch {
    return "unknown";
  }
}

function abortReasonCategory(reason: unknown): "abort" | "deadline" | "unknown" {
  try {
    if (reason instanceof DOMException) {
      if (reason.name === "TimeoutError") {
        return "deadline";
      }
      if (reason.name === "AbortError") {
        return "abort";
      }
    }
  } catch {
    // An opaque reason stays private and cannot prevent signal observation.
  }
  return "unknown";
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
  const stage = async <T>(
    name: string,
    run: () => Promise<T>,
    signals?: Partial<Record<AbortSource, AbortSignal>>,
  ): Promise<T> => {
    const stageStartedAt = now();
    const abortedSources = () => ABORT_SOURCES.filter((source) => signals?.[source]?.aborted);
    const initial = abortedSources();
    let firstAbortSource: CrabboxProvisionStageEvent["firstAbortSource"] =
      initial.length === 0 ? "none" : initial.length === 1 ? initial[0] : "unknown";
    let reason: unknown = initial.length === 1 ? signals?.[initial[0]!]?.reason : undefined;
    const observation = () =>
      signals
        ? {
            firstAbortSource,
            abortedSources: abortedSources(),
            abortReasonCategory: abortReasonCategory(reason),
          }
        : {};
    const listeners = ABORT_SOURCES.flatMap((source) => {
      const signal = signals?.[source];
      if (!signal || signal.aborted) {
        return [];
      }
      const observe = () => {
        if (firstAbortSource !== "none") {
          return;
        }
        firstAbortSource = abortedSources().length === 1 ? source : "unknown";
        reason = firstAbortSource === "unknown" ? undefined : signal.reason;
        try {
          abortLog.info("worker provision signal aborted", {
            operationId,
            leaseId,
            stage: name,
            ...observation(),
          });
        } catch {
          // The first signal observation cannot close or settle the operation.
        }
      };
      signal.addEventListener("abort", observe, { once: true });
      return [{ signal, observe }];
    });
    publish({
      leaseId,
      operationId,
      stage: name,
      elapsedMs: 0,
      totalElapsedMs: stageStartedAt - startedAt,
      outcome: "started",
      ...observation(),
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
        ...observation(),
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
        ...observation(),
      });
      throw error;
    } finally {
      for (const { signal, observe } of listeners) {
        signal.removeEventListener("abort", observe);
      }
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
  "cache",
]);
const SETUP_STAGES = new Set([
  "node_probe",
  "node_install",
  "node_validation",
  "package_prerequisites",
  "helper_projection",
  "rust_setup",
  "azure_cli_setup",
  "azure_version",
  "azure_package",
  "azure_payload",
  "azure_install",
  "azure_identity",
  "azure_credential",
  "env_load",
  "credential_acquisition",
  "credential_transport",
  "repository_channel",
  "msrustup_probe",
  "msrustup_install",
  "toolchain_probe",
  "toolchain_install",
  "provenance",
  "compiler_probe",
  "formatter_probe",
  "clippy_probe",
]);
const SETUP_MARKER =
  /^TEAMCLAW_SETUP_V1 stage=([a-z_]+) outcome=(started|succeeded|failed)(?: exit=(0|[1-9]\d{0,2}))?(?: elapsedMs=(0|[1-9]\d{0,9}))?$/u;
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
      const setup = SETUP_MARKER.exec(line);
      if (setup && setup[1] !== undefined && SETUP_STAGES.has(setup[1]) && line.length <= 512) {
        const elapsedMs = setup[4] === undefined ? undefined : Number(setup[4]);
        if (
          (elapsedMs !== undefined && elapsedMs > 2_147_483_647) ||
          (setup[3] !== undefined && Number(setup[3]) > 255)
        ) {
          continue;
        }
        try {
          emit({
            leaseId,
            operationId,
            stage: `setup-${setup[1]}`,
            outcome:
              setup[2] === "succeeded"
                ? "completed"
                : setup[2] === "started"
                  ? "started"
                  : "failed",
            ...(elapsedMs === undefined ? {} : { elapsedMs }),
            ...(setup[2] === "failed" ? { errorCode: "setup_failed" } : {}),
          });
        } catch {
          // Remote timing never changes command custody or outcome.
        }
        continue;
      }
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
        let runtimeCache: CrabboxProvisionStageEvent["runtimeCache"];
        if (event.stage === "cache") {
          const cache = event.runtimeCache;
          if (
            !isRecord(cache) ||
            typeof cache.expectedSha256 !== "string" ||
            !/^[a-f0-9]{64}$/.test(cache.expectedSha256) ||
            (cache.homeCategory !== "root" && cache.homeCategory !== "other") ||
            (cache.uidCategory !== "root" &&
              cache.uidCategory !== "non-root" &&
              cache.uidCategory !== "unavailable") ||
            typeof cache.cacheHit !== "boolean" ||
            (cache.missReason !== "none" &&
              cache.missReason !== "runtime_missing" &&
              cache.missReason !== "worker_archive_missing" &&
              cache.missReason !== "verification_failed")
          ) {
            continue;
          }
          runtimeCache = {
            expectedSha256: cache.expectedSha256,
            homeCategory: cache.homeCategory,
            uidCategory: cache.uidCategory,
            cacheHit: cache.cacheHit,
            missReason: cache.missReason,
          };
        }
        try {
          emit({
            leaseId,
            operationId,
            stage: `worker-${event.stage}`,
            elapsedMs: event.elapsedMs,
            totalElapsedMs: event.totalElapsedMs,
            outcome: event.outcome,
            ...(runtimeCache ? { runtimeCache } : {}),
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

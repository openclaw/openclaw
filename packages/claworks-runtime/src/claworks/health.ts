import { runClaworksDoctor, type DoctorCheck } from "./doctor.js";
import { runtimeUptimeSeconds } from "./observability.js";
import type { ClaworksRuntime } from "./runtime-types.js";

export type ClaworksHealthStatus = "ok" | "degraded" | "unavailable";

export function resolveHealthStatus(checks: DoctorCheck[]): ClaworksHealthStatus {
  if (checks.some((c) => c.status === "error")) {
    return "unavailable";
  }
  if (checks.some((c) => c.status === "warn")) {
    return "degraded";
  }
  return "ok";
}

export function buildHealthPayload(runtime: ClaworksRuntime) {
  const checks = runClaworksDoctor(runtime);
  const status = resolveHealthStatus(checks);
  return {
    status,
    robot: runtime.robot.name,
    role: runtime.robot.role,
    version: runtime.robot.version,
    kb_provider: runtime.config.data?.kb_provider ?? "stub",
    kb_vector: runtime.config.data?.kb_provider === "memory-core",
    kb_embed_model: runtime.config.data?.kb_embed_model,
    uptime_s: runtimeUptimeSeconds(),
    planes: {
      kernel: status === "unavailable" ? "error" : "ok",
      data: checks.find((c) => c.id === "database")?.status === "error" ? "error" : "ok",
      orch: checks.find((c) => c.id === "playbooks")?.status === "error" ? "error" : "ok",
    },
    checks,
  };
}
